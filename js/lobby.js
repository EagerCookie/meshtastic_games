/**
 * Mesh Artillery — Lobby
 *
 * Game discovery and matchmaking:
 *  - Host: broadcast "offer" packets, listen for "join", send "accept"
 *  - Client: listen for "offer" packets, send "join", wait for "accept"
 */

import {
  offerPacket, joinPacket, acceptPacket, cancelPacket, forfeitPacket, pingPacket,
  GAME_TTL,
} from './protocol.js';
import { makeGameId } from './utils/hash.js';

export class Lobby {
  /**
   * @param {import('./transport.js').Transport} transport
   * @param {string} nodeId - our node ID
   * @param {string} nick - our nickname
   */
  constructor(transport, nodeId, nick) {
    this.transport = transport;
    this.nodeId = nodeId;
    this.nick = nick;

    /** @type {Map<string, OpenGame>} gameId -> OpenGame */
    this.games = new Map();
    this.lastPoll = Date.now() / 1000;

    // Listen for all incoming packets
    this.transport.onMessage((packet) => this._handlePacket(packet));
  }

  // ================================================================
  // Public API
  // ================================================================

  /**
   * Broadcast an offer to create a new game.
   * Returns the game ID.
   */
  openGame(gameId = null, gameType = 'artillery') {
    const id = gameId || makeGameId();
    this.transport.sendPublic(offerPacket(id, this.nodeId, this.nick, gameType));
    return id;
  }

  /**
   * Send a join request to the host of an open game.
   */
  joinGame(game) {
    const packet = joinPacket(game.gameId, this.nodeId, this.nick);
    this.transport.sendDirect(game.nodeId, packet);
  }

  /**
   * Accept a join request — host sends this back.
   * @param {string} gameId
   * @param {string} joinerNodeId
   * @param {number} seed - terrain seed
   * @param {number} whoFirst - 1 = host goes first, 2 = joiner goes first
   */
  acceptJoin(gameId, joinerNodeId, seed, whoFirst = 1, gameType = 'artillery') {
    const packet = acceptPacket(gameId, this.nodeId, this.nick, seed, whoFirst, gameType);
    this.transport.sendDirect(joinerNodeId, packet);
  }

  /**
   * Cancel an open game (broadcast) or an active game (direct).
   */
  cancel(gameId, destNode = null) {
    const packet = cancelPacket(gameId, this.nodeId, this.nick);
    if (destNode) {
      this.transport.sendDirect(destNode, packet);
    } else {
      this.transport.sendPublic(packet);
    }
  }

  /**
   * Close an offer (host removes game from lobby without cancelling active game).
   */
  closeOffer(gameId) {
    // Send cancel as broadcast — all nodes will remove from their lists
    this.transport.sendPublic(cancelPacket(gameId, this.nodeId, this.nick));
  }

  /**
   * Send a forfeit (surrender).
   */
  forfeit(gameId, destNode) {
    this.transport.sendDirect(destNode, forfeitPacket(gameId, this.nodeId, this.nick));
  }

  /**
   * Send a ping (ACK for a received message).
   */
  sendPing(gameId, destNode, ackMsgId) {
    this.transport.sendDirect(destNode, pingPacket(gameId, this.nodeId, this.nick, ackMsgId));
  }

  /**
   * Poll for new games. Also cleans up expired games.
   * @returns {OpenGame[]} list of currently open games
   */
  listGames() {
    this._expireGames();
    return Array.from(this.games.values())
      .sort((a, b) => b.seenAt - a.seenAt);
  }

  // ================================================================
  // Packet handling
  // ================================================================

  /**
   * Called for every incoming packet. Updates the lobby state.
   * Returns the packet (unchanged) for the app to handle further.
   */
  _handlePacket(packet) {
    switch (packet.t) {
      case 'offer':
        if (packet.s !== this.nodeId) {
          this.games.set(packet.g, {
            gameId: packet.g,
            nick: packet.n,
            nodeId: packet.s,
            seenAt: Date.now() / 1000,
          });
        }
        break;

      case 'cancel':
        this.games.delete(packet.g);
        break;
    }
  }

  // ================================================================
  // Internal
  // ================================================================

  _expireGames() {
    const now = Date.now() / 1000;
    for (const [id, game] of this.games) {
      if (now - game.seenAt > GAME_TTL) {
        this.games.delete(id);
      }
    }
  }
}

/**
 * @typedef {Object} OpenGame
 * @property {string} gameId
 * @property {string} nick - host's nickname
 * @property {string} nodeId - host's node ID
 * @property {number} seenAt - timestamp when last seen
 */
