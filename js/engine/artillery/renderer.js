/**
 * Canvas renderer for the artillery game.
 * Handles all drawing: sky, terrain, tanks, projectiles, explosions.
 */

import { CANVAS_WIDTH, CANVAS_HEIGHT } from './terrain.js';

// Colors
const SKY_TOP = '#0a0a2e';
const SKY_BOTTOM = '#1a1a4e';
const TERRAIN_COLOR = '#2d5a1e';
const TERRAIN_TOP = '#3d7a2e';
const CRATER_RIM = '#4a3a1e';
const TANK_BODY_P1 = '#4488cc';
const TANK_BODY_P2 = '#cc4444';
const TANK_BARREL = '#333';
const PROJECTILE_COLOR = '#ffdd44';
const TRAIL_COLOR = 'rgba(255, 220, 60, 0.6)';
const EXPLOSION_COLOR = '#ff8800';
const CROSSHAIR_COLOR = 'rgba(255, 255, 255, 0.3)';

// Polyfill for Canvas roundRect (not yet in all browsers)
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (typeof r === 'number') r = { tl: r, tr: r, br: r, bl: r };
    this.beginPath();
    this.moveTo(x + r.tl, y);
    this.lineTo(x + w - r.tr, y);
    this.quadraticCurveTo(x + w, y, x + w, y + r.tr);
    this.lineTo(x + w, y + h - r.br);
    this.quadraticCurveTo(x + w, y + h, x + w - r.br, y + h);
    this.lineTo(x + r.bl, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r.bl);
    this.lineTo(x, y + r.tl);
    this.quadraticCurveTo(x, y, x + r.tl, y);
    this.closePath();
    return this;
  };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Set logical size
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = CANVAS_HEIGHT;

    // Handle resize
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const parentW = parent.clientWidth;
    const parentH = parent.clientHeight;
    const scale = Math.min(parentW / CANVAS_WIDTH, parentH / CANVAS_HEIGHT);

    this.canvas.style.width = `${CANVAS_WIDTH * scale}px`;
    this.canvas.style.height = `${CANVAS_HEIGHT * scale}px`;
    this.scale = scale;
  }

  /**
   * Render a complete frame.
   * @param {Object} state - game engine state
   */
  render(state) {
    if (!state) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    this._drawSky(ctx);
    this._drawTerrain(ctx, state.terrain);
    this._drawTank(ctx, state.tanks.p1, TANK_BODY_P1, state.tanks.p1.angle);
    this._drawTank(ctx, state.tanks.p2, TANK_BODY_P2, state.tanks.p2.angle);

    if (state.projectile && state.projectile.active) {
      this._drawTrail(ctx, state.projectile.trail);
      this._drawProjectile(ctx, state.projectile.x, state.projectile.y);
    }

    if (state.explosion && state.explosion.active) {
      this._drawExplosion(ctx, state.explosion);
    }

    ctx.restore();
  }

  _drawSky(ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT * 0.7);
    gradient.addColorStop(0, SKY_TOP);
    gradient.addColorStop(1, SKY_BOTTOM);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }

  _drawTerrain(ctx, terrain) {
    if (!terrain) return;

    // Main terrain fill
    ctx.beginPath();
    ctx.moveTo(0, CANVAS_HEIGHT);

    for (let x = 0; x < CANVAS_WIDTH; x++) {
      ctx.lineTo(x, terrain[x]);
    }

    ctx.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT);
    gradient.addColorStop(0.55, TERRAIN_TOP);
    gradient.addColorStop(1, TERRAIN_COLOR);
    ctx.fillStyle = gradient;
    ctx.fill();

    // Surface line
    ctx.beginPath();
    ctx.moveTo(0, terrain[0]);
    for (let x = 1; x < CANVAS_WIDTH; x++) {
      ctx.lineTo(x, terrain[x]);
    }
    ctx.strokeStyle = '#5a9a3e';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _drawTank(ctx, tank, bodyColor, barrelAngle) {
    if (!tank) return;
    const { x, y } = tank;
    const w = 24;
    const h = 14;
    const barrelLen = 18;
    const barrelWidth = 3;

    // Body
    const bodyX = x - w / 2;
    const bodyY = y + h / 2;

    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.roundRect(bodyX, bodyY, w, h, 4);
    ctx.fill();

    // Outline
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Turret (small dome)
    const turretCX = x;
    const turretCY = bodyY + h / 2;
    ctx.fillStyle = _lighten(bodyColor, 20);
    ctx.beginPath();
    ctx.arc(turretCX, turretCY, w / 5, 0, Math.PI * 2);
    ctx.fill();

    // Barrel
    const angleRad = (barrelAngle * Math.PI) / 180;
    const barrelStartX = turretCX;
    const barrelStartY = turretCY;
    const barrelEndX = barrelStartX + Math.cos(angleRad) * barrelLen;
    const barrelEndY = barrelStartY - Math.sin(angleRad) * barrelLen; // Y increases downward

    ctx.strokeStyle = TANK_BARREL;
    ctx.lineWidth = barrelWidth;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(barrelStartX, barrelStartY);
    ctx.lineTo(barrelEndX, barrelEndY);
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  _drawProjectile(ctx, x, y) {
    ctx.fillStyle = PROJECTILE_COLOR;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();

    // Glow
    ctx.fillStyle = 'rgba(255, 220, 60, 0.3)';
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawTrail(ctx, trail) {
    if (!trail || trail.length < 2) return;

    ctx.strokeStyle = TRAIL_COLOR;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();

    for (let i = 0; i < trail.length; i++) {
      const pt = trail[i];
      if (i === 0) {
        ctx.moveTo(pt.x, pt.y);
      } else {
        ctx.lineTo(pt.x, pt.y);
      }
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  _drawExplosion(ctx, explosion) {
    const { x, y, radius, progress } = explosion; // progress: 0..1

    const alpha = 1 - progress;
    const currentRadius = radius * (0.3 + progress * 0.7);

    // Outer blast
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, currentRadius);
    gradient.addColorStop(0, 'rgba(255, 255, 200, ' + alpha + ')');
    gradient.addColorStop(0.3, 'rgba(255, 180, 30, ' + (alpha * 0.8) + ')');
    gradient.addColorStop(0.6, 'rgba(255, 80, 0, ' + (alpha * 0.4) + ')');
    gradient.addColorStop(1, 'rgba(255, 40, 0, 0)');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, currentRadius, 0, Math.PI * 2);
    ctx.fill();

    // Particles
    const particleCount = Math.floor(12 * (1 - progress * 0.5));
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2 + progress * 4;
      const dist = currentRadius * (0.4 + Math.random() * 0.6);
      const px = x + Math.cos(angle) * dist;
      const py = y + Math.sin(angle) * dist * 0.5;

      ctx.fillStyle = 'rgba(255, ' + (150 + Math.random() * 105).toFixed(0) + ', 0, ' + alpha + ')';
      ctx.beginPath();
      ctx.arc(px, py, 1.5 + Math.random(), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Draw a targeting line from tank barrel showing trajectory preview.
   */
  drawAimLine(x, y, angle, power) {
    const ctx = this.ctx;
    const angleRad = (angle * Math.PI) / 180;
    const barrelLen = 18;

    const startX = x + Math.cos(angleRad) * barrelLen;
    const startY = y + 7 - Math.sin(angleRad) * barrelLen;

    // Simple preview: dotted line in aiming direction
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = CROSSHAIR_COLOR;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(startX, startY);

    const previewLen = power * 1.2;
    const endX = startX + Math.cos(angleRad) * previewLen;
    const endY = startY - Math.sin(angleRad) * previewLen;
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

/** Lighten a hex color by an amount */
function _lighten(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.min(255, r + amount);
  const lg = Math.min(255, g + amount);
  const lb = Math.min(255, b + amount);
  return `rgb(${lr},${lg},${lb})`;
}
