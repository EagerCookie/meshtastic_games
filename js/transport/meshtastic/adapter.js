/**
 * MeshtasticAdapter — wraps protobuf + BLE/Serial/HTTP connection
 * and exposes our game's Transport interface.
 *
 * Usage:
 *   const adapter = await MeshtasticAdapter.create('ble');
 *   adapter.onMessage(packet => console.log(packet));
 *   adapter.sendPublic(gamePacket);
 *   adapter.sendDirect(destNodeId, gamePacket);
 */

import { Transport } from '../../transport.js';
import { decodePacket } from '../../protocol.js';
import { encodeGamePacket, decodeFromRadio, encodeWantConfig, encodeHeartbeat, encodeKickstartPacket } from './protobuf.js';
import {
  createBleConnection,
  createSerialConnection,
  createHttpConnection,
} from './connection.js';

// Game traffic channel.
// 0 = Primary (always works, no PSK config needed)
// 1 = Games (secondary — requires same PSK on both nodes)
const DEFAULT_CHANNEL = 1;

const ts = () => new Date().toLocaleTimeString();

export class MeshtasticAdapter extends Transport {
  /** @param {'ble'|'serial'|'http'} connectionType */
  constructor(connectionType, options = {}) {
    super();
    this._type = connectionType;
    this._options = options; // { httpUrl, channelIndex }
    this._conn = null;
    this._myNodeNum = null;
    this._myNodeNumIsFallback = false; // true if we're using a random ID
    this._heartbeatTimer = null;       // config heartbeat interval
    this._lastSerialActivity = 0;      // timestamp of last serial data (for idle detection)
    this._queueStatusHandler = null;   // callback for TX queue status
    this._channelIndex = options.channelIndex ?? DEFAULT_CHANNEL;
    this._nodeIdToNum = new Map(); // game nodeId (string) → meshtastic nodeNum
    this._numToNodeId = new Map(); // meshtastic nodeNum → game nodeId
  }

  // ===================================================================
  // Factory — auto-connect
  // ===================================================================

  static async create(type, options = {}) {
    const adapter = new MeshtasticAdapter(type, options);
    await adapter.connect();
    return adapter;
  }

  // ===================================================================
  // Connect / Disconnect
  // ===================================================================

  async connect() {
    // Create the underlying connection
    switch (this._type) {
      case 'ble':
        this._conn = await createBleConnection();
        break;
      case 'serial':
        this._conn = await createSerialConnection();
        break;
      case 'http':
        if (!this._options.httpUrl) throw new Error('HTTP URL required for WiFi connection');
        this._conn = await createHttpConnection(this._options.httpUrl);
        break;
      default:
        throw new Error(`Unknown connection type: ${this._type}`);
    }

    // Wire up data BEFORE connecting (catches MyNodeInfo)
    this._conn.onData(bytes => this._onRawData(bytes));
    this._conn.onDisconnect(() => {
      this._connected = false;
      this._notifyConnection();
    });

    // Connect to hardware
    await this._conn.connect();

    // Request node config / MyNodeInfo.
    // Serial: heartbeat retries every 4s until node boots and responds.
    // HTTP/BLE: single request is enough (node is always in API mode).
    if (this._type === 'serial') {
      console.log('[Meshtastic] Starting API handshake (heartbeat every 4s)...');
      this._startConfigHeartbeat();
    } else {
      // HTTP / BLE: single request is enough (node is always in API mode).
      try {
        await this._conn.write(encodeWantConfig());
        console.log('[Meshtastic] Sent wantConfigId to request MyNodeInfo');
      } catch (e) {
        console.warn('[Meshtastic] wantConfigId failed:', e.message);
      }
    }

    // Wait for MyNodeInfo. For Serial, we're patient — up to 60s
    // because the device may be booting with debug logging.
    try {
      this._myNodeNum = await this._waitForMyNodeNum(
        this._type === 'serial' ? 60000 : 15000
      );
      this._myNodeNumIsFallback = false;
    } catch (_) {
      this._myNodeNum = (Math.floor(Math.random() * 0x7FFFFFFF) + 1);
      this._myNodeNumIsFallback = true;
      console.warn('[Meshtastic] No MyNodeInfo — using random ID:', '0x'+this._myNodeNum.toString(16));
    }

    // Set nodeId in game format (!XXXXXXXX = 8-char hex)
    this.nodeId = `!${this._myNodeNum.toString(16).padStart(8, '0')}`;

    this._connected = true;
    this._notifyConnection();

    console.log(`[Meshtastic] Connected via ${this._type}, nodeId=${this.nodeId}, nodeNum=${this._myNodeNum}`);
  }

  /**
   * Send wantConfigId every 4 seconds until the node responds
   * with MyNodeInfo. This mirrors the official client's configHeartbeat.
   */
  _startConfigHeartbeat() {
    let tick = 0;
    const send = async () => {
      if (!this._conn) return;
      // Stop if we already got a real MyNodeInfo (not fallback)
      if (this._myNodeNum !== null && !this._myNodeNumIsFallback) return;
      try {
        // Send only wantConfigId (field 3) — no kickstart/text packets
        // to avoid garbage in the Meshtastic chat on the primary channel.
        if (tick % 2 === 0) {
          await this._conn.write(encodeWantConfig());
          console.log('[Meshtastic] wantConfigId (field 3) sent');
        } else {
          await this._conn.write(encodeHeartbeat());
          console.log('[Meshtastic] Heartbeat (field 7) sent');
        }
        tick++;
      } catch (e) {
        console.warn('[Meshtastic] Heartbeat write failed:', e.message, e.name);
      }
    };
    send(); // fire first one immediately (wantConfigId field 3)
    this._heartbeatTimer = setInterval(send, 4000);
  }

  _stopConfigHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  disconnect() {
    this._connected = false;
    this._stopConfigHeartbeat();
    if (this._conn) {
      try { this._conn.disconnect(); } catch (_) {}
      this._conn = null;
    }
    super.disconnect();
  }

  // ===================================================================
  // Transport interface
  // ===================================================================

  /**
   * Broadcast a game packet to all nodes on the channel.
   */
  sendPublic(packet) {
    return this._sendPacket(packet, undefined); // undefined = broadcast
  }

  /**
   * Send a game packet directly to a specific node.
   * NOTE: currently broadcasting everything for debugging visibility.
   */
  sendDirect(_destNodeId, packet) {
    return this._sendPacket(packet, undefined); // broadcast for debugging
  }

  // ===================================================================
  // Internal
  // ===================================================================

  // Serial write queue — prevents overlapping QueueStatus handlers
  _writeQueue = Promise.resolve();

  _enqueueWrite(fn) {
    const result = this._writeQueue.then(() => fn());
    // Don't let a rejection break the queue chain
    this._writeQueue = result.catch(() => {});
    return result;
  }

  async _sendPacket(packet, destNum, retries = 3) {
    if (!this._connected || !this._conn) {
      console.warn('[Meshtastic] Not connected, dropping packet');
      return;
    }

    // For HTTP: simple fire-and-forget, no queue needed
    if (this._type !== 'serial') {
      const jsonStr = typeof packet === 'string' ? packet : JSON.stringify(packet);
      const bytes = encodeGamePacket(jsonStr, this._myNodeNum, this._channelIndex, destNum);
      const dest = (destNum !== undefined ? '→0x'+destNum.toString(16) : '→broadcast');
      console.log(ts(), 'TX', packet.t, packet.g, 'ch=' + this._channelIndex, dest);
      try {
        const result = this._conn.write(bytes);
        if (result && typeof result.then === 'function') await result;
              } catch (e) {
        console.warn('[Meshtastic] Write error:', e.message);
      }
      return;
    }

    // Serial: queue writes to avoid overlapping QueueStatus handlers
    return this._enqueueWrite(() => this._sendPacketSerial(packet, destNum, retries));
  }

  async _sendPacketSerial(packet, destNum, retries) {
    const jsonStr = typeof packet === 'string' ? packet : JSON.stringify(packet);
    const bytes = encodeGamePacket(jsonStr, this._myNodeNum, this._channelIndex, destNum);

    for (let attempt = 0; attempt < retries; attempt++) {
      const dest = (destNum !== undefined ? '→0x'+destNum.toString(16) : '→broadcast');
      console.log(ts(), 'TX', packet.t, packet.g, 'ch=' + this._channelIndex, dest);

      try {
        await this._conn.write(bytes);
      } catch (e) {
        console.warn('[Meshtastic] Write error:', e.message);
        if (attempt < retries - 1) { await new Promise(r => setTimeout(r, 1500)); continue; }
        return;
      }

      // Wait for QueueStatus
      const status = await new Promise((resolve) => {
        this._queueStatusHandler = resolve;
        setTimeout(() => resolve('timeout'), 5000);
      });
      this._queueStatusHandler = null;

      if (status === 'timeout') {
        console.warn(ts(), '[Meshtastic] No QueueStatus after 5000ms' +
                     (attempt < retries - 1 ? ', retrying...' : ', giving up'));
        if (attempt < retries - 1) { await new Promise(r => setTimeout(r, 1500)); continue; }
        return;
      }

      if (status.free > 0) {
        console.log(ts(), '[Meshtastic] Packet queued OK (free=' + status.free +
                    ' maxlen=' + status.maxlen + ' pktId=0x' + status.meshPacketId.toString(16) + ')');
        return;
      }

      console.warn(ts(), '[Meshtastic] TX queue full (free=' + status.free + ')' +
                   (attempt < retries - 1 ? ', retrying...' : ', giving up'));
      if (attempt < retries - 1) { await new Promise(r => setTimeout(r, 1500)); }
    }
  }

  _onRawData(bytes) {
    const decoded = decodeFromRadio(bytes, false); // debug off for less noise
    if (!decoded) {
      return; // non-game/non-queue packet — ignore
    }

    // QueueStatus — route to active send handler for TX confirmation
    if (decoded.type === 'queueStatus') {
      if (this._queueStatusHandler) {
        this._queueStatusHandler(decoded);
      }
      return;
    }

    if (decoded.type === 'myInfo') {
      console.log('[Meshtastic] Got MyNodeInfo:', decoded.myNodeNum);
      // Accept real MyNodeInfo from the device even if we already fell back
      // to a random ID (the device is the authoritative source).
      if (decoded.myNodeNum !== null && decoded.myNodeNum !== undefined) {
        const wasFallback = this._myNodeNumIsFallback;
        this._myNodeNum = decoded.myNodeNum;
        this._myNodeNumIsFallback = false;
        this.nodeId = `!${this._myNodeNum.toString(16).padStart(8, '0')}`;
        this._stopConfigHeartbeat();
        if (wasFallback) {
          console.log('[Meshtastic] Replaced random ID with real MyNodeInfo:', decoded.myNodeNum);
        }
      }
      return;
    }

    if (decoded.type === 'packet') {
      // If packet has myNodeNum attached (from combined FromRadio), update it
      if (decoded.myNodeNum !== null && decoded.myNodeNum !== undefined) {
        const wasFallback = this._myNodeNumIsFallback;
        this._myNodeNum = decoded.myNodeNum;
        this._myNodeNumIsFallback = false;
        this.nodeId = `!${this._myNodeNum.toString(16).padStart(8, '0')}`;
        this._stopConfigHeartbeat();
        if (wasFallback) {
          console.log('[Meshtastic] Replaced random ID with MyNodeInfo from packet:', decoded.myNodeNum);
        }
      }

      if (decoded.portnum !== 1) {
        // Not a TEXT_MESSAGE_APP packet — telemetry, routing, etc. Ignore.
        return;
      }

      // TEXT_MESSAGE_APP (portnum=1) — our game packets
      const text = decoded.payload ? new TextDecoder().decode(decoded.payload) : '';
      if (!text) return;

      try {
        // Decode the compact JSON into a full packet object
        // (converts t:'o' → t:'offer', validates, etc.)
        const gamePacket = decodePacket(text);
        console.log(ts(), 'RX', gamePacket.t, gamePacket.g, '←', gamePacket.s);

        // Track nodeId ↔ nodeNum mapping
        const senderNum = decoded.from;
        const senderId = `!${senderNum.toString(16).padStart(8, '0')}`;
        if (!this._nodeIdToNum.has(senderId)) {
          this._nodeIdToNum.set(senderId, senderNum);
          this._numToNodeId.set(senderNum, senderId);
        }

        // Deliver to game via standard Transport interface
        // Attach metadata
        gamePacket._transport = {
          scope: decoded.to === 0xFFFFFFFF ? 'public' : 'direct',
          senderNodeNum: senderNum,
        };

        this._receivePacket(gamePacket);
      } catch (e) {
        // silently ignore non-game text messages
      }
    } else {
      console.log('[Meshtastic] Unknown decoded type:', decoded.type);
    }
  }

  /**
   * Wait for the node to send MyNodeInfo so we know our node number.
   * Resolves when received, or rejects after timeout.
   */
  _waitForMyNodeNum(timeoutMs = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this._myNodeNum !== null && this._myNodeNum !== undefined) {
          resolve(this._myNodeNum);
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error('Timed out waiting for MyNodeInfo from Meshtastic node'));
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }
}
