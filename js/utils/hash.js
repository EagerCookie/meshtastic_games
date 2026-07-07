/**
 * SHA-256 wrapper using Web Crypto API.
 * Used for commit verification and packet integrity.
 */

/**
 * Compute SHA-256 hash of a string.
 * Returns hex string (full 64 chars).
 */
export async function sha256(message) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute SHA-256 hash synchronously (if available) or return null.
 * Falls back to a simple non-crypto hash for development.
 * In production, always use the async version.
 */
export function simpleHash(message) {
  // DJB2 hash — NOT cryptographic, used for non-security purposes only
  let hash = 5381;
  for (let i = 0; i < message.length; i++) {
    hash = ((hash << 5) + hash + message.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Generate a random salt for commit-reveal.
 * Returns hex string.
 */
export function makeSalt() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a random message ID (4 hex chars).
 */
export function makeMsgId() {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a random game ID (4 uppercase alphanumeric chars).
 */
export function makeGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += chars[bytes[i] % chars.length];
  }
  return id;
}
