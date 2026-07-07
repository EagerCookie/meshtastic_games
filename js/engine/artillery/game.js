/**
 * Artillery Game Engine
 *
 * Pure game logic — no networking, no UI, no rendering.
 * Extends BaseEngine so it can be swapped for another game type.
 */

import { BaseEngine } from '../base.js';
import { generateTerrain, getTankPositions, applyCrater, CANVAS_WIDTH, CANVAS_HEIGHT } from './terrain.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GRAVITY = 9.8 * 0.6;
const MAX_HP = 100;
const MAX_DAMAGE = 50;
const TANK_HEIGHT = 14;

// ---------------------------------------------------------------------------
// ArtilleryEngine
// ---------------------------------------------------------------------------
export class ArtilleryEngine extends BaseEngine {
  constructor() {
    super();
    this._state = null;
  }

  // ===================================================================
  // Lifecycle
  // ===================================================================

  init(seed, p1Name, p2Name) {
    const terrain = generateTerrain(seed);
    const positions = getTankPositions(terrain, CANVAS_WIDTH, TANK_HEIGHT);

    this._state = {
      seed,
      terrain,
      round: 1,
      wind: 0,
      outcome: null,         // null | 'p1' | 'p2' | 'draw' | 'forfeit'
      outcomeFromForfeit: false,

      tanks: {
        p1: { x: positions.p1.x, y: positions.p1.y, hp: MAX_HP, angle: 45, name: p1Name },
        p2: { x: positions.p2.x, y: positions.p2.y, hp: MAX_HP, angle: 135, name: p2Name },
      },

      projectile: { active: false, x: 0, y: 0, vx: 0, vy: 0, trail: [] },
      explosion: { active: false, x: 0, y: 0, radius: 0, progress: 0, duration: 0.6, elapsed: 0 },

      // Internal sim state (null when idle)
      _simData: null,
      // Who is currently shooting? 'p1' | 'p2' | null
      _currentShooter: null,
    };

    this._settleTanks();
  }

  reset() {
    this._state = null;
  }

  // ===================================================================
  // Actions (local player)
  // ===================================================================

  /**
   * @param {number} playerIdx  0 = P1, 1 = P2
   * @param {{angle: number, powerPct: number}} action
   * @returns {{angle:number, powerPct:number, wind:number, round:number}|null}
   */
  playerAction(playerIdx, action) {
    const gs = this._state;
    if (!gs || gs.outcome) return null;
    if (gs._simData) return null; // already animating

    const { angle, powerPct } = action;
    const shooterKey = playerIdx === 0 ? 'p1' : 'p2';
    const targetKey = playerIdx === 0 ? 'p2' : 'p1';
    const shooter = gs.tanks[shooterKey];
    const target = gs.tanks[targetKey];

    shooter.angle = angle;
    gs._currentShooter = shooterKey;

    const power = 2 + powerPct * 0.6;
    const angleRad = (angle * Math.PI) / 180;
    const barrelLen = 18;
    const launchX = shooter.x + Math.cos(angleRad) * barrelLen;
    const launchY = shooter.y + 7 - Math.sin(angleRad) * barrelLen;

    this._simulateShot(launchX, launchY, angle, power, powerPct, gs.wind,
                        gs.terrain, target);

    // Return data for network packet
    return {
      angle,
      powerPct,
      wind: gs.wind,
      round: gs.round,
    };
  }

  /**
   * @param {number} playerIdx  0 = P1, 1 = P2
   * @param {{angle:number, powerPct:number, wind:number, round:number}} data
   */
  applyOpponentAction(playerIdx, data) {
    const gs = this._state;
    if (!gs || gs.outcome) return;
    if (gs._simData) return;

    const { angle, powerPct } = data;
    const shooterKey = playerIdx === 0 ? 'p1' : 'p2';
    const targetKey = playerIdx === 0 ? 'p2' : 'p1';
    const shooter = gs.tanks[shooterKey];
    const target = gs.tanks[targetKey];

    // Sync wind from opponent's packet
    gs.wind = data.wind || 0;
    shooter.angle = angle;
    gs._currentShooter = shooterKey;

    const power = 2 + powerPct * 0.6;
    const angleRad = (angle * Math.PI) / 180;
    const barrelLen = 18;
    const launchX = shooter.x + Math.cos(angleRad) * barrelLen;
    const launchY = shooter.y + 7 - Math.sin(angleRad) * barrelLen;

    this._simulateShot(launchX, launchY, angle, power, powerPct, gs.wind,
                        gs.terrain, target);
  }

  // ===================================================================
  // Simulation
  // ===================================================================

  update(dt) {
    const gs = this._state;
    if (!gs) return;

    // Projectile physics
    if (gs._simData) {
      this._updateProjectile(dt);
    }

    // Explosion animation
    if (gs.explosion?.active) {
      gs.explosion.elapsed += dt;
      gs.explosion.progress = Math.min(1, gs.explosion.elapsed / gs.explosion.duration);
      if (gs.explosion.progress >= 1) {
        gs.explosion.active = false;
      }
    }
  }

  // ===================================================================
  // Query
  // ===================================================================

  isAnimating() {
    return !!(this._state?._simData);
  }

  getState() {
    return this._state;
  }

  get outcome() {
    return this._state?.outcome ?? null;
  }

  get round() {
    return this._state?.round ?? 0;
  }

  get wind() {
    return this._state?.wind ?? 0;
  }

  get p1Hp() {
    return this._state?.tanks?.p1?.hp ?? 100;
  }

  get p2Hp() {
    return this._state?.tanks?.p2?.hp ?? 100;
  }

  get p1Angle() {
    return this._state?.tanks?.p1?.angle ?? 45;
  }

  get p2Angle() {
    return this._state?.tanks?.p2?.angle ?? 135;
  }

  get currentShooter() {
    return this._state?._currentShooter ?? null;
  }

  /**
   * Aim data for preview line.
   */
  getAimData(playerIdx) {
    const gs = this._state;
    if (!gs) return null;
    const tank = gs.tanks[playerIdx === 0 ? 'p1' : 'p2'];
    return { x: tank.x, y: tank.y + 7, angle: tank.angle };
  }

  /**
   * Advance to next round. Returns true if game continues, false if game over.
   */
  advanceRound() {
    const gs = this._state;
    if (!gs || gs.outcome) return false;
    gs.round++;
    // Generate wind for new round
    gs.wind = ((gs.seed * 31 + gs.round * 17) % 41) - 20;
    return true;
  }

  /**
   * End game via forfeit.
   * @param {'p1'|'p2'} forfeiter
   */
  forfeit(forfeiter) {
    const gs = this._state;
    if (!gs) return;
    gs.outcome = forfeiter === 'p1' ? 'p2' : 'p1';
    gs.outcomeFromForfeit = true;
  }

  // ===================================================================
  // Physics internals
  // ===================================================================

  _simulateShot(x, y, angle, power, powerPct, wind, terrain, target) {
    const gs = this._state;
    const angleRad = (angle * Math.PI) / 180;
    let px = x, py = y;
    let vx = power * Math.cos(angleRad) + wind * 0.3;
    let vy = -power * Math.sin(angleRad);

    const trail = [{ x: px, y: py, frame: 0 }];
    const dt = 1 / 60;

    gs.projectile = { active: true, x: px, y: py, vx, vy, trail: [{ x: px, y: py }] };
    gs._simData = {
      px, py, vx, vy, trail, dt, terrain, target, powerPct, wind,
      frame: 0, done: false, impactX: 0, impactY: 0, missed: false,
    };
  }

  _updateProjectile(_dt) {
    const sim = this._state?._simData;
    if (!sim || sim.done) return;

    const steps = 2;
    for (let s = 0; s < steps; s++) {
      if (sim.done) break;

      const windAccel = (sim.wind || 0) * 0.15;
      sim.vx += windAccel * sim.dt;
      sim.vy += GRAVITY * sim.dt;
      sim.px += sim.vx * sim.dt;
      sim.py += sim.vy * sim.dt;
      sim.frame++;

      if (sim.frame % 2 === 0) {
        sim.trail.push({ x: sim.px, y: sim.py, frame: sim.frame });
        if (sim.trail.length > 120) sim.trail.shift();
      }

      // Terrain collision
      const ix = Math.round(sim.px);
      if (ix >= 0 && ix < CANVAS_WIDTH && sim.py >= sim.terrain[ix]) {
        sim.done = true;
        sim.impactX = sim.px;
        sim.impactY = sim.terrain[ix];
        this._onImpact(sim.impactX, sim.impactY, sim.target);
        return;
      }

      // Tank hit
      const hitTank = this._checkTankHit(sim.px, sim.py);
      if (hitTank) {
        sim.done = true;
        sim.impactX = sim.px;
        sim.impactY = sim.py;
        this._onImpact(sim.impactX, sim.impactY, hitTank);
        return;
      }

      // Out of bounds
      if (sim.px < 0 || sim.px >= CANVAS_WIDTH || sim.py >= CANVAS_HEIGHT || sim.py < -200) {
        sim.done = true;
        sim.missed = true;
        this._onMiss();
        return;
      }
    }

    this._state.projectile.x = sim.px;
    this._state.projectile.y = sim.py;
  }

  _onImpact(x, y, target) {
    const gs = this._state;
    const sim = gs._simData;
    const powerPct = sim?.powerPct ?? 50;
    const radius = 15 + powerPct * 0.4;
    const damage = this._calcDamage(x, y, target, radius);

    target.hp = Math.max(0, target.hp - damage);

    applyCrater(gs.terrain, x, y, radius);
    this._settleTanks();

    gs.explosion = { active: true, x, y, radius, progress: 0, duration: 0.6, elapsed: 0 };
    gs.projectile.active = false;
    gs._simData = null;
    gs._currentShooter = null;

    this._checkGameEnd();
  }

  _onMiss() {
    const gs = this._state;
    gs.projectile.active = false;
    gs._simData = null;
    gs._currentShooter = null;
  }

  _calcDamage(impactX, impactY, target, radius) {
    const dist = Math.sqrt(
      (impactX - target.x) ** 2 + (impactY - (target.y + TANK_HEIGHT / 2)) ** 2
    );
    if (dist > radius) return 0;
    return Math.round(MAX_DAMAGE * (1 - dist / radius));
  }

  _checkTankHit(px, py) {
    const gs = this._state;
    if (!gs) return null;
    const TANK_W = 16, TANK_H = 20;
    for (const key of ['p1', 'p2']) {
      const tank = gs.tanks[key];
      if (px >= tank.x - TANK_W && px <= tank.x + TANK_W &&
          py >= tank.y && py <= tank.y + TANK_H) {
        return tank;
      }
    }
    return null;
  }

  _settleTanks() {
    const gs = this._state;
    if (!gs) return;
    for (const key of ['p1', 'p2']) {
      const tank = gs.tanks[key];
      const groundY = gs.terrain[Math.round(tank.x)];
      tank.y = groundY - TANK_HEIGHT;
      if (tank.y < 0) tank.y = 0;
    }
  }

  _checkGameEnd() {
    const gs = this._state;
    if (!gs || gs.outcome) return;

    const p1Dead = gs.tanks.p1.hp <= 0;
    const p2Dead = gs.tanks.p2.hp <= 0;

    if (p1Dead && p2Dead) gs.outcome = 'draw';
    else if (p1Dead) gs.outcome = 'p2';
    else if (p2Dead) gs.outcome = 'p1';
  }

  // ===================================================================
  // Wind for next round (called when entering MY_TURN)
  // ===================================================================
  generateWind() {
    const gs = this._state;
    if (!gs) return;
    gs.wind = ((gs.seed * 31 + gs.round * 17) % 41) - 20;
  }
}
