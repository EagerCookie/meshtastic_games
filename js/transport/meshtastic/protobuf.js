/**
 * Minimal Protobuf encode/decode for Meshtastic ToRadio / FromRadio / MeshPacket / Data.
 *
 * Hand-written to avoid dependencies. Only supports the field numbers and types
 * we actually use. Wire format: https://protobuf.dev/programming-guides/encoding/
 *
 * Field encoding:
 *   tag = (field_number << 3) | wire_type
 *   wire_type 0 = varint, wire_type 2 = length-delimited
 */

// ---------------------------------------------------------------------------
// PortNum enum (only what we use)
// ---------------------------------------------------------------------------
export const PortNum = { TEXT_MESSAGE_APP: 1 };

// ---------------------------------------------------------------------------
// Varint helpers
// ---------------------------------------------------------------------------
function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0; // unsigned 32-bit
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return bytes.length === 0 ? [0] : bytes;
}

function decodeVarint(bytes, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < bytes.length) {
    const b = bytes[i++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, nextOffset: i };
}

// ---------------------------------------------------------------------------
// Tag helpers
// ---------------------------------------------------------------------------
function makeTag(fieldNumber, wireType) {
  return (fieldNumber << 3) | wireType;
}

function readTag(bytes, offset) {
  const { value: tag, nextOffset } = decodeVarint(bytes, offset);
  return {
    fieldNumber: tag >>> 3,
    wireType: tag & 0x07,
    nextOffset,
  };
}

// ---------------------------------------------------------------------------
// Field writers
// ---------------------------------------------------------------------------
function writeVarintField(fieldNum, value) {
  const tag = encodeVarint(makeTag(fieldNum, 0));
  const val = encodeVarint(value);
  return [...tag, ...val];
}

function writeBytesField(fieldNum, data) {
  const tag = encodeVarint(makeTag(fieldNum, 2));
  const len = encodeVarint(data.length);
  const result = [...tag, ...len];
  for (let i = 0; i < data.length; i++) result.push(data[i]);
  return result;
}

function writeFixed32Field(fieldNum, value) {
  const tag = encodeVarint(makeTag(fieldNum, 5)); // wire_type 5 = 32-bit fixed
  const val = [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
  return [...tag, ...val];
}

// ---------------------------------------------------------------------------
// Data message (portnum + payload)
// ---------------------------------------------------------------------------
function encodeData(portnum, payloadBytes) {
  return [
    ...writeVarintField(1, portnum),
    ...writeBytesField(2, payloadBytes),
  ];
}

// ---------------------------------------------------------------------------
// MeshPacket message
// ---------------------------------------------------------------------------
function encodeMeshPacket({ from, to, channel, dataBytes, id, wantAck, hopLimit }) {
  const parts = [];
  // Meshtastic uses fixed32 for from/to/id in firmware
  if (from !== undefined) parts.push(...writeFixed32Field(1, from));
  if (to !== undefined) parts.push(...writeFixed32Field(2, to));
  if (channel !== undefined) parts.push(...writeVarintField(3, channel));
  if (dataBytes) parts.push(...writeBytesField(4, dataBytes));
  if (id !== undefined) parts.push(...writeFixed32Field(6, id || 0));
  if (hopLimit !== undefined) parts.push(...writeVarintField(9, hopLimit));
  if (wantAck) parts.push(...writeVarintField(10, 1));
  return parts;
}

// ---------------------------------------------------------------------------
// ToRadio message (wrapper around MeshPacket)
// ---------------------------------------------------------------------------
export function encodeToRadio(meshPacketFields) {
  const meshBytes = encodeMeshPacket(meshPacketFields);
  // Firmware version uses field 1 for MeshPacket in ToRadio (matches FromRadio behavior)
  const toRadioBytes = writeBytesField(1, meshBytes);
  return new Uint8Array(toRadioBytes);
}

// ---------------------------------------------------------------------------
// Decode FromRadio → extract MeshPacket fields → return Data payload
// ---------------------------------------------------------------------------

/**
 * Decode a FromRadio protobuf message.
 * Returns { type: 'packet', from, to, channel, portnum, payload: Uint8Array, id }
 *      or { type: 'myInfo', myNodeNum }
 *      or { type: 'queueStatus', free, maxlen, meshPacketId }
 *      or null.
 */
export function decodeFromRadio(bytes, debug = false) {
  if (!bytes || bytes.length === 0) return null;

  if (debug) console.log('[Proto] decodeFromRadio, len:', bytes.length,
                         'first bytes:', Array.from(bytes.slice(0,16)).map(b=>b.toString(16).padStart(2,'0')).join(' '));

  let meshPacketBytes = null;
  let myNodeNum = null;
  let queueStatus = null;
  let offset = 0;

  while (offset < bytes.length) {
    const { fieldNumber, wireType, nextOffset } = readTag(bytes, offset);
    offset = nextOffset;

    if (debug) console.log('[Proto] FromRadio field:', fieldNumber, 'wireType:', wireType, 'at offset:', offset);

    if (wireType === 2) {
      const { value: len, nextOffset: dataStart } = decodeVarint(bytes, offset);
      const data = bytes.slice(dataStart, dataStart + len);
      offset = dataStart + len;
      if (debug) console.log('[Proto]   length-delimited, len:', len);
      // MeshPacket can be at field 1 OR field 2 depending on firmware version
      if (fieldNumber === 1 || fieldNumber === 2) {
        meshPacketBytes = data;
        if (debug) console.log('[Proto]   → meshPacketBytes (field', fieldNumber + ')');
      } else if (fieldNumber === 3) {
        const info = _decodeMyNodeInfo(data, debug);
        if (info !== null) myNodeNum = info;
        if (debug) console.log('[Proto]   → MyNodeInfo, nodeNum:', info);
      } else if (fieldNumber === 11) {
        // QueueStatus — tells us if our packet was queued for TX
        queueStatus = _decodeQueueStatus(data, debug);
        if (debug) console.log('[Proto]   → QueueStatus:', queueStatus);
      }
    } else if (wireType === 0) {
      const { value, nextOffset: afterVarint } = decodeVarint(bytes, offset);
      offset = afterVarint;
      if (debug) console.log('[Proto]   varint value:', value);
    } else if (wireType === 5) {
      if (offset + 4 <= bytes.length) {
        const val = _readFixed32(bytes, offset);
        if (debug) console.log('[Proto]   fixed32 value:', val, '=', '0x'+val.toString(16));
      }
      offset += 4;
    } else {
      if (debug) console.log('[Proto]   unknown wireType, breaking');
      break;
    }
  }

  // Priority: MeshPacket (game data) > MyNodeInfo > QueueStatus.
  // QueueStatus is last because HTTP responses often have
  // [QueueStatus][MeshPacket] concatenated — we must not let
  // QueueStatus shadow the game packet.
  if (meshPacketBytes) {
    const packet = decodeMeshPacket(meshPacketBytes, debug);
    if (packet) {
      packet.type = 'packet';
      if (myNodeNum !== null) packet.myNodeNum = myNodeNum;
      if (queueStatus !== null) packet.queueStatus = queueStatus;
      if (debug) console.log('[Proto] → returning packet, from:', '0x'+packet.from.toString(16));
      return packet;
    }
  }
  if (myNodeNum !== null) {
    if (debug) console.log('[Proto] → returning myInfo, nodeNum:', myNodeNum);
    return { type: 'myInfo', myNodeNum };
  }
  if (queueStatus !== null) {
    return { type: 'queueStatus', ...queueStatus };
  }
  if (debug) console.log('[Proto] → returning null');
  return null;
}

/** Decode QueueStatus (FromRadio field 11). */
function _decodeQueueStatus(bytes, debug = false) {
  let offset = 0;
  let free = -1, maxlen = -1, meshPacketId = 0;
  while (offset < bytes.length) {
    const { fieldNumber, wireType, nextOffset } = readTag(bytes, offset);
    offset = nextOffset;
    if (wireType === 0) {
      const { value, nextOffset: afterVarint } = decodeVarint(bytes, offset);
      offset = afterVarint;
      if (fieldNumber === 2) free = value;
      else if (fieldNumber === 3) maxlen = value;
      else if (fieldNumber === 4) meshPacketId = value;
    } else {
      break;
    }
  }
  return { free, maxlen, meshPacketId };
}

/** Extract my_node_num from MyNodeInfo protobuf (field 1). */
function _decodeMyNodeInfo(bytes, debug = false) {
  let offset = 0;
  while (offset < bytes.length) {
    const { fieldNumber, wireType, nextOffset } = readTag(bytes, offset);
    offset = nextOffset;
    if (debug) console.log('[Proto] MyNodeInfo field:', fieldNumber, 'wireType:', wireType);
    if (wireType === 0) {
      const { value, nextOffset: afterVarint } = decodeVarint(bytes, offset);
      offset = afterVarint;
      if (debug) console.log('[Proto]   varint:', value);
      if (fieldNumber === 1) return value;
    } else if (wireType === 5) {
      const val = _readFixed32(bytes, offset);
      if (debug) console.log('[Proto]   fixed32:', val);
      if (fieldNumber === 1) return val;
      offset += 4;
    } else if (wireType === 2) {
      const { value: len, nextOffset: dataStart } = decodeVarint(bytes, offset);
      if (debug) console.log('[Proto]   bytes, len:', len);
      offset = dataStart + len;
      // Recursively decode nested node info if needed
      if (fieldNumber === 1) {
        // Sometimes my_node_num is wrapped in another level
        for (let i = 0; i < Math.min(8, len); i++) {
          if (dataStart + i < bytes.length) {
            // Try reading as raw bytes
          }
        }
      }
    } else {
      if (debug) console.log('[Proto]   unknown wireType');
      break;
    }
  }
  return null;
}

function decodeMeshPacket(bytes, debug = false) {
  let offset = 0;
  const result = { from: 0, to: 0, channel: 0, portnum: 0, payload: null, id: 0, wantAck: false };
  let dataBytes = null;

  if (debug) console.log('[Proto] decodeMeshPacket, len:', bytes.length);

  while (offset < bytes.length) {
    const { fieldNumber, wireType, nextOffset } = readTag(bytes, offset);
    offset = nextOffset;
    if (debug) console.log('[Proto]   MeshPacket field:', fieldNumber, 'wireType:', wireType);

    // wire_type 0 = varint (uint32, int32, bool, enum)
    if (wireType === 0) {
      const { value, nextOffset: afterVarint } = decodeVarint(bytes, offset);
      offset = afterVarint;
      switch (fieldNumber) {
        case 1: result.from = value; break;
        case 2: result.to = value; break;
        case 3: result.channel = value; break;
        case 6: result.id = value; break;
        case 10: result.wantAck = value !== 0; break;
        case 13: result.wantAck = value !== 0; break; // some firmware uses field 13
      }
    // wire_type 5 = fixed32 (Meshtastic encodes from/to/id as fixed32 in some firmware)
    } else if (wireType === 5) {
      const value = _readFixed32(bytes, offset);
      offset += 4;
      switch (fieldNumber) {
        case 1: result.from = value; break;
        case 2: result.to = value; break;
        case 3: result.channel = value; break;
        case 6: result.id = value; break;
      }
    } else if (wireType === 2) {
      const { value: len, nextOffset: dataStart } = decodeVarint(bytes, offset);
      const data = bytes.slice(dataStart, dataStart + len);
      offset = dataStart + len;
      if (fieldNumber === 4) dataBytes = data;
    } else {
      break;
    }
  }

  if (dataBytes) {
    const decoded = decodeData(dataBytes);
    if (decoded) {
      result.portnum = decoded.portnum;
      result.payload = decoded.payload;
    }
  }

  return result;
}

/** Read 4 bytes as little-endian uint32. */
function _readFixed32(bytes, offset) {
  return ((bytes[offset] | (bytes[offset + 1] << 8) |
           (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0);
}

function decodeData(bytes) {
  let offset = 0;
  let portnum = 0;
  let payload = null;

  while (offset < bytes.length) {
    const { fieldNumber, wireType, nextOffset } = readTag(bytes, offset);
    offset = nextOffset;

    if (wireType === 0) {
      const { value, nextOffset: afterVarint } = decodeVarint(bytes, offset);
      offset = afterVarint;
      if (fieldNumber === 1) portnum = value;
    } else if (wireType === 2) {
      const { value: len, nextOffset: dataStart } = decodeVarint(bytes, offset);
      const data = bytes.slice(dataStart, dataStart + len);
      offset = dataStart + len;
      if (fieldNumber === 2) payload = data;
    } else {
      break;
    }
  }

  return { portnum, payload };
}

// ---------------------------------------------------------------------------
// High-level helpers for our game
// ---------------------------------------------------------------------------

const BROADCAST_ADDR = 0xFFFFFFFF;

/**
 * Encode a JSON game packet for sending over LoRa.
 *
 * @param {string} jsonStr  - our compact JSON game packet
 * @param {number} nodeNum  - our node number (from meshtastic)
 * @param {number} channel  - channel index (1+)
 * @param {number} destNum  - destination node number, or undefined for broadcast
 * @returns {Uint8Array}    - raw protobuf bytes to write to transport
 */
export function encodeGamePacket(jsonStr, nodeNum, channel, destNum) {
  const textBytes = new TextEncoder().encode(jsonStr);
  const dataBytes = encodeData(PortNum.TEXT_MESSAGE_APP, textBytes);
  const isDirect = destNum !== undefined;
  const meshFields = {
    from: 0,  // let node fill its own ID
    to: isDirect ? destNum : BROADCAST_ADDR,
    channel,
    dataBytes,
    id: 0,      // let node auto-generate
    // Only request ACK for direct messages — broadcast ACKs clog the mesh
    wantAck: isDirect,
    hopLimit: 3, // default mesh hop limit
  };
  return encodeToRadio(meshFields);
}

/**
 * Decode incoming protobuf bytes. Returns { json: string, from: number } or null.
 */
export function decodeGamePacket(bytes) {
  const decoded = decodeFromRadio(bytes);
  if (!decoded || !decoded.payload) return null;
  // Only process TEXT_MESSAGE_APP packets (ignore telemetry, routing, etc.)
  if (decoded.portnum !== PortNum.TEXT_MESSAGE_APP) return null;
  const text = new TextDecoder().decode(decoded.payload);
  return {
    json: text,
    from: decoded.from,
    to: decoded.to,
    packetId: decoded.id,
  };
}

/**
 * Build a minimal ToRadio with want_config_id set.
 * Field number from the official Meshtastic web client (web-main) schema:
 *   ToRadio.want_config_id = field 3 (varint)
 * This is the modern protobuf oneof schema.
 */
export function encodeWantConfig() {
  const parts = writeVarintField(3, 1);
  return new Uint8Array(parts);
}

/**
 * Legacy wantConfigId at field 100 (old protobuf schema).
 * Some firmware / HTTP API versions expect this instead of field 3.
 */
export function encodeWantConfigLegacy() {
  const parts = writeVarintField(100, 1);
  return new Uint8Array(parts);
}

/**
 * Build a ToRadio heartbeat (field 7).
 * Official client sends this to keep the serial connection alive.
 */
export function encodeHeartbeat() {
  // ToRadio field 7 (heartbeat), wire_type 2 (length-delimited), empty payload
  const parts = writeBytesField(7, []);
  return new Uint8Array(parts);
}

/**
 * Build a complete ToRadio with MeshPacket containing a minimal text message.
 * This mirrors bridge.py's build_to_radio() — a full MeshPacket forces the
 * node to process the ToRadio and enter API mode.
 */
export function encodeKickstartPacket() {
  const textBytes = new TextEncoder().encode('KI');
  const dataBytes = encodeData(PortNum.TEXT_MESSAGE_APP, textBytes);
  const meshFields = {
    from: 0,
    to: BROADCAST_ADDR,
    channel: 0,
    dataBytes,
    id: 0,
    wantAck: false,
  };
  return encodeToRadio(meshFields);
}
