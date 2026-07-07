/**
 * Base Game Engine — abstract interface.
 *
 * Every game (artillery, sea-battle, etc.) extends this class.
 * The transport/protocol layers know nothing about game mechanics —
 * they just deliver actions and receive action data.
 */

export class BaseEngine {
  // -------------------------------------------------------------------
  // Lifecycle — must override
  // -------------------------------------------------------------------

  /** Initialize a new game. Receives the terrain seed and player names. */
  init(_seed, _p1Name, _p2Name) {
    throw new Error('Not implemented');
  }

  /** Reset engine state for a new round. */
  reset() {
    throw new Error('Not implemented');
  }

  // -------------------------------------------------------------------
  // Actions — called by local player
  // -------------------------------------------------------------------

  /**
   * Player performs an action.
   * @param {number} playerIdx  0 = P1, 1 = P2
   * @param {Object} action     game-specific (e.g. {angle, powerPct} for artillery)
   * @returns {Object|null}     data to send to opponent, or null if action is invalid
   */
  playerAction(_playerIdx, _action) {
    throw new Error('Not implemented');
  }

  /**
   * Apply opponent's action (received from network).
   * @param {number} playerIdx  0 = P1, 1 = P2
   * @param {Object} data       game-specific action data
   */
  applyOpponentAction(_playerIdx, _data) {
    throw new Error('Not implemented');
  }

  // -------------------------------------------------------------------
  // Simulation — called every frame
  // -------------------------------------------------------------------

  /**
   * Advance simulation by dt seconds.
   * @param {number} dt  delta time in seconds
   */
  update(_dt) {
    throw new Error('Not implemented');
  }

  // -------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------

  /** @returns {boolean} true while a projectile/animation is active */
  isAnimating() {
    throw new Error('Not implemented');
  }

  /**
   * Visual state for the renderer.
   * Game-specific structure — renderer knows how to interpret it.
   * @returns {Object}
   */
  getState() {
    throw new Error('Not implemented');
  }

  /** @returns {string|null} 'p1', 'p2', 'draw', or null if ongoing */
  get outcome() {
    throw new Error('Not implemented');
  }

  /** @returns {number} current round number */
  get round() {
    throw new Error('Not implemented');
  }

  // -------------------------------------------------------------------
  // Optional — override if game has these concepts
  // -------------------------------------------------------------------

  /** Wind value for display (artillery-specific). @returns {number} */
  get wind() { return 0; }

  /** P1 HP for display. @returns {number} */
  get p1Hp() { return 100; }

  /** P2 HP for display. @returns {number} */
  get p2Hp() { return 100; }

  /** P1 angle for display. @returns {number} */
  get p1Angle() { return 0; }

  /** P2 angle for display. @returns {number} */
  get p2Angle() { return 0; }

  /**
   * Get aim-line data for drawing a targeting preview.
   * @returns {{x:number, y:number, angle:number}|null}
   */
  getAimData(_playerIdx) { return null; }
}
