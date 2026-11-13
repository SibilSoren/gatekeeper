/**
 * True for the keys a store keeps for `key`: the key itself, and
 * `key:<window number>` for window counters. False for a different key that
 * only starts the same way, such as `gk:1.2.3.45` when resetting `gk:1.2.3.4`.
 */
export function isOwnKey(candidate: string, key: string): boolean {
  if (candidate === key) return true;
  if (!candidate.startsWith(`${key}:`)) return false;
  return /^\d+$/.test(candidate.slice(key.length + 1));
}

/** Escape Redis glob characters so text matches itself in a SCAN pattern. */
export function escapeGlob(text: string): string {
  return text.replace(/[*?[\]\\]/g, '\\$&');
}
