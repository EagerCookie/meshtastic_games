import { SeededRNG } from '../../utils/rng.js';

/**
 * Terrain generation and deformation for the artillery game.
 * Uses seeded multi-octave noise for deterministic, reproducible terrain.
 */

// Canvas logical resolution
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 400;

// Terrain constants
const MIN_FLAT_RADIUS = 30;  // pixels of flat ground around tank positions
const TANK_PLATFORM_WIDTH = 40;

/**
 * Generate a terrain heightmap.
 * @param {number} seed - deterministic seed
 * @param {number} width - canvas width (default 800)
 * @param {number} height - canvas height (default 400)
 * @returns {Float64Array} terrain heights for each x column
 */
export function generateTerrain(seed, width = CANVAS_WIDTH, height = CANVAS_HEIGHT) {
  const rng = new SeededRNG(seed);
  const terrain = new Float64Array(width);

  // Base elevation — ground sits at ~65% from top
  const baseY = height * 0.65;

  // Generate raw noise
  for (let x = 0; x < width; x++) {
    let y = baseY;

    // 4 octaves of noise
    for (let octave = 0; octave < 4; octave++) {
      const freq = Math.pow(2, octave);
      const amp = 35 / (octave + 1);
      const nx = x / (width / freq);
      y += rng.noise2D(nx, octave * 0.7) * amp;
    }

    terrain[x] = Math.round(y);
  }

  // Clamp to valid range
  for (let x = 0; x < width; x++) {
    terrain[x] = Math.max(20, Math.min(height - 20, terrain[x]));
  }

  // Flatten tank positions
  const p1X = Math.floor(width * 0.15);
  const p2X = Math.floor(width * 0.85);
  _flattenArea(terrain, p1X, TANK_PLATFORM_WIDTH, width);
  _flattenArea(terrain, p2X, TANK_PLATFORM_WIDTH, width);

  // Smooth terrain
  _smooth(terrain, 2);

  return terrain;
}

/**
 * Get initial tank positions.
 * @returns {{ p1: {x: number, y: number}, p2: {x: number, y: number} }}
 */
export function getTankPositions(terrain, width = CANVAS_WIDTH, tankHeight = 24) {
  const p1X = Math.floor(width * 0.15);
  const p2X = Math.floor(width * 0.85);

  // Tank sits ON the terrain surface
  const p1Y = terrain[p1X] - tankHeight;
  const p2Y = terrain[p2X] - tankHeight;

  return {
    p1: { x: p1X, y: p1Y },
    p2: { x: p2X, y: p2Y },
  };
}

/**
 * Apply crater deformation at impact point.
 * @param {Float64Array} terrain
 * @param {number} impactX
 * @param {number} impactY
 * @param {number} radius - explosion radius
 * @param {number} width - canvas width
 */
export function applyCrater(terrain, impactX, impactY, radius, width = CANVAS_WIDTH) {
  const depth = radius * 0.5;

  for (let x = Math.floor(impactX - radius); x <= Math.ceil(impactX + radius); x++) {
    if (x < 0 || x >= width) continue;

    const dist = Math.abs(x - impactX);

    // Cosine-weighted deformation for smooth crater edge
    const factor = Math.cos((dist / radius) * (Math.PI / 2));
    if (factor <= 0) continue;

    const deformation = depth * factor;
    terrain[x] = Math.min(terrain[x] + deformation, CANVAS_HEIGHT - 5);
  }
}

/**
 * Smooth terrain in-place (moving average).
 */
function _smooth(terrain, passes) {
  const width = terrain.length;
  for (let pass = 0; pass < passes; pass++) {
    const smoothed = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      const left = terrain[Math.max(0, x - 2)];
      const right = terrain[Math.min(width - 1, x + 2)];
      smoothed[x] = (left + terrain[x] + right) / 3;
    }
    for (let x = 0; x < width; x++) {
      terrain[x] = smoothed[x];
    }
  }
}

/**
 * Flatten area around a point so tanks sit on level ground.
 */
function _flattenArea(terrain, centerX, radius, width) {
  const startX = Math.max(0, centerX - radius);
  const endX = Math.min(width - 1, centerX + radius);
  let sum = 0;
  let count = 0;

  for (let x = startX; x <= endX; x++) {
    sum += terrain[x];
    count++;
  }

  const avg = sum / count;

  // Blend to average (smooth transition)
  const blendRadius = radius + 8;
  for (let x = Math.max(0, centerX - blendRadius); x <= Math.min(width - 1, centerX + blendRadius); x++) {
    const dist = Math.abs(x - centerX);
    const t = Math.min(1, Math.max(0, (blendRadius - dist) / (blendRadius - radius)));
    terrain[x] = terrain[x] + (avg - terrain[x]) * t;
  }
}
