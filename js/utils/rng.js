/**
 * Seeded PRNG — xorshift128+
 * Deterministic: same seed always produces the same sequence.
 * Used for terrain generation, wind, and any game randomness
 * that must be identical on both clients.
 */
export class SeededRNG {
  constructor(seed) {
    // Split 32-bit seed into two 64-bit state values (using float-safe bounds)
    this.state0 = ((seed >>> 0) ^ 0x9E3779B9) >>> 0;
    this.state1 = ((seed * 0xDEADBEEF) ^ 0xC0FFEE) >>> 0;
    // Skip first few to decorrelate from seed
    for (let i = 0; i < 10; i++) this.next();
  }

  /** Returns a 32-bit unsigned integer */
  next32() {
    let s1 = this.state0 >>> 0;
    const s0 = this.state1 >>> 0;
    this.state0 = s0;
    s1 ^= (s1 << 23) >>> 0;
    s1 ^= (s1 >>> 17);
    s1 ^= s0;
    s1 ^= (s0 >>> 26);
    this.state1 = s1;
    return ((s0 + s1) >>> 0);
  }

  /** Returns a float in [0, 1) */
  next() {
    return this.next32() / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive */
  nextInt(min, max) {
    const range = max - min + 1;
    return min + Math.floor(this.next() * range);
  }

  /**
   * Simple 2D noise using value-noise approach.
   * Not true Perlin, but produces smooth terrain-like results.
   */
  noise2D(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;

    // Smooth step
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);

    // Hash corners
    const aa = this._hash(xi, yi);
    const ba = this._hash(xi + 1, yi);
    const ab = this._hash(xi, yi + 1);
    const bb = this._hash(xi + 1, yi + 1);

    // Interpolate
    const x1 = aa + u * (ba - aa);
    const x2 = ab + u * (bb - ab);
    return x1 + v * (x2 - x1);
  }

  /** Internal hash for noise */
  _hash(x, y) {
    let h = ((x * 374761393) + (y * 668265263) + 1274126177) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    h = h ^ (h >>> 16);
    return (h / 4294967296) * 2 - 1; // [-1, 1]
  }
}
