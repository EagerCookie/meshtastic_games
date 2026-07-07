/**
 * Mesh Artillery — Transport Layer
 *
 * Unified interface for connecting the browser to a Meshtastic node
 * via different physical layers. Three implementations:
 *
 *   MockTransport   — BroadcastChannel API for local dev (two browser tabs)
 *   BLETransport    — Web Bluetooth (Phase 4)
 *   SerialTransport — Web Serial (Phase 4)
 *   WiFiTransport   — HTTP to node IP (Phase 4)
 */

import { decodePacket, ProtocolError } from './protocol.js';

// ============================================================
// Transport Interface (base class)
// ============================================================
export class Transport {
  constructor() {
    this.nodeId = null;
    this._messageHandlers = [];
    this._connectionHandlers = [];
    this._connected = false;
  }

  get connected() { return this._connected; }

  /** Override in subclass to open the connection. */
  async connect(_options) {
    throw new Error('Not implemented');
  }

  /** Override in subclass to close the connection. */
  disconnect() {
    this._connected = false;
    this._notifyConnection();
  }

  /** Broadcast a packet to all nodes on the channel. */
  sendPublic(_packet) {
    throw new Error('Not implemented');
  }

  /** Send a packet directly to a specific node. */
  sendDirect(_destNode, _packet) {
    throw new Error('Not implemented');
  }

  /** Register a handler: called with every incoming decoded packet. */
  onMessage(handler) {
    this._messageHandlers.push(handler);
  }

  /** Register a handler: called with (connected: boolean) on change. */
  onConnectionChange(handler) {
    this._connectionHandlers.push(handler);
  }

  /** Subclasses call this when a new packet arrives. */
  _receivePacket(packet) {
    for (const h of this._messageHandlers) {
      try { h(packet); } catch (e) { console.error('[Transport] handler error:', e); }
    }
  }

  _notifyConnection() {
    for (const h of this._connectionHandlers) {
      try { h(this._connected); } catch (e) { /* ignore */ }
    }
  }
}

// ============================================================
// MockTransport — BroadcastChannel between browser tabs
// ============================================================
const MOCK_CHANNEL_NAME = 'mesh_artillery_mock';

export class MockTransport extends Transport {
  constructor(nodeId) {
    super();
    this.nodeId = nodeId || this._generateNodeId();

    // Use BroadcastChannel for cross-tab communication
    this._channel = new BroadcastChannel(MOCK_CHANNEL_NAME);
    this._channel.onmessage = (event) => {
      this._handleRaw(event.data);
    };

    this._connected = true;
    this._lastPolls = {}; // track last poll time per source node
  }

  _generateNodeId() {
    const hex = Array.from({ length: 4 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join('');
    return `!mock${hex}`;
  }

  async connect(_options) {
    // Mock is always "connected"
    this._connected = true;
    this._notifyConnection();
  }

  disconnect() {
    this._channel.close();
    super.disconnect();
  }

  /**
   * Broadcast to all tabs. The sender is filtered by _handleRaw.
   */
  sendPublic(packet) {
    this._channel.postMessage({
      scope: 'public',
      dest: '*',
      sender: this.nodeId,
      packet: this._serializePacket(packet),
    });
  }

  /**
   * Direct message to a specific node. Still goes through the shared BroadcastChannel
   * but only the matching nodeId processes it (or all nodes see it but filter).
   */
  sendDirect(destNode, packet) {
    this._channel.postMessage({
      scope: 'direct',
      dest: destNode,
      sender: this.nodeId,
      packet: this._serializePacket(packet),
    });
  }

  /** Poll for new messages (returns accumulated packets since last poll). */
  pollMessages() {
    // Messages arrive via BroadcastChannel.onmessage callback,
    // which calls _receivePacket directly. So poll is a no-op.
    // This method exists for compatibility with DuelMesh-style polling.
  }

  // ---- internal ----

  _serializePacket(packet) {
    // If already a string, return it; otherwise encode
    if (typeof packet === 'string') return packet;
    if (packet.encode) return packet.encode();
    return JSON.stringify(packet);
  }

  _handleRaw(raw) {
    // Ignore own messages
    if (raw.sender === this.nodeId) return;

    try {
      let packetObj;
      if (typeof raw.packet === 'string') {
        try {
          packetObj = decodePacket(raw.packet);
        } catch (e) {
          // Not a MeshArtillery packet — try legacy JSON parse
          const parsed = JSON.parse(raw.packet);
          if (parsed && parsed.a === 'mg') {
            packetObj = decodePacket(parsed);
          } else {
            return; // ignore non-game messages
          }
        }
      } else if (typeof raw.packet === 'object') {
        packetObj = decodePacket(raw.packet);
      } else {
        return;
      }

      // For direct messages, only process if we're the intended recipient
      if (raw.scope === 'direct' && raw.dest !== this.nodeId) return;

      // Attach transport metadata
      packetObj._transport = {
        scope: raw.scope,
        sender: raw.sender,
        dest: raw.dest,
      };

      this._receivePacket(packetObj);
    } catch (e) {
      if (e instanceof ProtocolError) {
        // Ignore non-game packets
        return;
      }
      console.warn('[MockTransport] Error handling message:', e);
    }
  }
}
