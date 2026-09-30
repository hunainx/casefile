import { randomBytes } from "node:crypto";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generates a 26-character monotonically sortable ULID string per PRD §59.2.
 */
export function generateUlid(timestampMs: number = Date.now()): string {
  let timeStr = "";
  let time = timestampMs;

  for (let i = 9; i >= 0; i--) {
    const mod = time % 32;
    timeStr = CROCKFORD_BASE32[mod] + timeStr;
    time = Math.floor(time / 32);
  }

  const bytes = randomBytes(10);
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    const byteIndex = Math.floor((i * 5) / 8);
    const bitOffset = (i * 5) % 8;
    let val: number;

    if (bitOffset <= 3) {
      val = (bytes[byteIndex]! >> (3 - bitOffset)) & 31;
    } else {
      const b1 = (bytes[byteIndex]! << (bitOffset - 3)) & 31;
      const b2 = (bytes[byteIndex + 1] ?? 0) >> (11 - bitOffset);
      val = b1 | b2;
    }

    randStr += CROCKFORD_BASE32[val % 32];
  }

  return timeStr + randStr;
}
