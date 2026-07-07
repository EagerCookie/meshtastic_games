/**
 * Mesh Artillery — Network Protocol
 *
 * Compact JSON packets with single-char keys to minimise LoRa payload.
 * Packet format: {"a":"mg","v":1,"t":"<code>","g":"<gameId>","s":"<nodeId>","n":"<nick>","d":{...}}
 *
 * Type codes:
 *   o = offer    (broadcast: game available)
 *   j = join     (direct: request to join)
 *   a = accept   (direct: host confirms + sends terrain seed)
 *   t = turn     (direct: angle, power, wind, keyframes, hash)
 *   p = ping     (implicit ACK + keepalive)
 *   r = result   (game over)
 *   f = forfeit  (surrender)
 *   k = cancel   (cancel game)
 */

import { makeMsgId, makeGameId } from './utils/hash.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const APP_PREFIX = 'mg';
export const PROTOCOL_VERSION = 1;

export const TYPE_CODES = {
  offer:   'o',
  join:    'j',
  accept:  'a',
  turn:    't',
  ping:    'p',
  result:  'r',
  forfeit: 'f',
  cancel:  'k',
};

export const CODE_TYPES = Object.fromEntries(
  Object.entries(TYPE_CODES).map(([k, v]) => [v, k])
);

export const ALL_TYPES = new Set(Object.keys(TYPE_CODES));

// Valid nickname regex (same as DuelMesh for interop)
const NICK_RE = /^[A-Za-z0-9_-]{3,12}$/;
const RESERVED_NICKS = new Set(['SYSTEM', 'ADMIN', 'SERVER', 'MESHGAMES', 'MESHGAMES']);

// Game TTL — open games expire after this many seconds
export const GAME_TTL = 30;

// ---------------------------------------------------------------------------
// ProtocolError
// ---------------------------------------------------------------------------
export class ProtocolError extends Error {
  constructor(msg) { super(msg); this.name = 'ProtocolError'; }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export function validateNick(nick) {
  if (!NICK_RE.test(nick)) {
    throw new ProtocolError('Nickname must be 3-12 chars: A-Z a-z 0-9 _ -');
  }
  if (RESERVED_NICKS.has(nick.toUpperCase())) {
    throw new ProtocolError('Nickname is reserved');
  }
  return nick;
}

// ---------------------------------------------------------------------------
// Packet encode / decode
// ---------------------------------------------------------------------------

/**
 * Build a packet object. Does NOT encode to string — use encodePacket() for that.
 */
export function buildPacket(type, gameId, nodeId, nick, data = {}, msgId = null) {
  if (!ALL_TYPES.has(type)) throw new ProtocolError(`Unknown packet type: ${type}`);
  return {
    a: APP_PREFIX,
    v: PROTOCOL_VERSION,
    t: TYPE_CODES[type],
    g: gameId,
    s: nodeId,
    n: nick,
    m: msgId || makeMsgId(),
    d: data,
  };
}

/**
 * Encode a packet object to a compact JSON string (no spaces).
 */
export function encodePacket(packet) {
  // Build explicitly to control key order and omit undefined
  const obj = {
    a: packet.a,
    v: packet.v,
    t: packet.t,
    g: packet.g,
    s: packet.s,
  };
  if (packet.n) obj.n = packet.n;
  if (packet.m) obj.m = packet.m;
  if (packet.d && Object.keys(packet.d).length > 0) obj.d = packet.d;
  return JSON.stringify(obj);  // no separators → compact
}

/**
 * Decode a JSON string (or already-parsed object) into a packet object.
 * Throws ProtocolError on any mismatch.
 */
export function decodePacket(raw) {
  let data;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new ProtocolError('Not a valid JSON packet');
    }
  } else if (typeof raw === 'object' && raw !== null) {
    data = raw;
  } else {
    throw new ProtocolError('Invalid packet input');
  }

  if (data.a !== APP_PREFIX) throw new ProtocolError('Wrong app prefix');
  if (data.v !== PROTOCOL_VERSION) throw new ProtocolError('Protocol version mismatch');

  const type = CODE_TYPES[data.t];
  if (!type || !ALL_TYPES.has(type)) throw new ProtocolError(`Unknown type code: ${data.t}`);

  if (!data.g || !data.s) throw new ProtocolError('Missing game ID or source node');

  // Don't reject packets with invalid nicknames — just sanitize.
  // Other nodes may use node IDs (with ! prefix) as nicknames.
  let nick = data.n || '';
  try { validateNick(nick); } catch (_) { nick = nick.replace(/[^A-Za-z0-9_-]/g, '').substring(0, 12) || 'Player'; }

  return {
    a: data.a,
    v: data.v,
    t: type,
    g: data.g,
    s: data.s,
    n: nick,
    m: data.m || '',
    d: data.d || {},
  };
}

// ---------------------------------------------------------------------------
// Packet builders for each type
// ---------------------------------------------------------------------------

export function offerPacket(gameId, nodeId, nick, gameType = 'artillery') {
  return buildPacket('offer', gameId, nodeId, nick, { game: gameType });
}

export function joinPacket(gameId, nodeId, nick) {
  return buildPacket('join', gameId, nodeId, nick, {});
}

export function acceptPacket(gameId, nodeId, nick, seed, whoFirst, gameType = 'artillery') {
  return buildPacket('accept', gameId, nodeId, nick, {
    seed: seed,
    pw: whoFirst,
    game: gameType,
  });
}

export function turnPacket(gameId, nodeId, nick, round, angle, powerPct, wind, keyframes, salt) {
  return buildPacket('turn', gameId, nodeId, nick, {
    r: round,
    a: angle,
    p: powerPct,
    w: wind,
    k: keyframes,
    h: salt,  // placeholder for hash (computed async)
  });
}

export function pingPacket(gameId, nodeId, nick, ackMsgId) {
  return buildPacket('ping', gameId, nodeId, nick, { m: ackMsgId });
}

export function resultPacket(gameId, nodeId, nick, winner, totalRounds) {
  return buildPacket('result', gameId, nodeId, nick, {
    w: winner,  // "p1", "p2", "draw"
    r: totalRounds,
  });
}

export function forfeitPacket(gameId, nodeId, nick) {
  return buildPacket('forfeit', gameId, nodeId, nick, {});
}

export function cancelPacket(gameId, nodeId, nick) {
  return buildPacket('cancel', gameId, nodeId, nick, {});
}

// ---------------------------------------------------------------------------
// Keyframe encoding (hybrid replay system)
// ---------------------------------------------------------------------------

/**
 * Encode array of {x, y, frame} keyframes into a compact hex string.
 * Format: "hexX/hexY/hexFrame_hexX/hexY/hexFrame_..."
 *   e.g.  "c8/172/0_12e/118/4b_1f4/c8/96"
 */
export function encodeKeyframes(keyframes) {
  return keyframes.map(kf => {
    const hx = Math.round(kf.x).toString(16);
    const hy = Math.round(kf.y).toString(16);
    const hf = Math.round(kf.frame || 0).toString(16);
    return `${hx}/${hy}/${hf}`;
  }).join('_');
}

/**
 * Decode a keyframe string back into an array of {x, y, frame} objects.
 */
export function decodeKeyframes(encoded) {
  if (!encoded) return [];
  return encoded.split('_').map(part => {
    const [hx, hy, hf] = part.split('/');
    return {
      x: parseInt(hx, 16),
      y: parseInt(hy, 16),
      frame: parseInt(hf || '0', 16),
    };
  });
}
