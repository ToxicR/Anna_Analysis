import crypto from "node:crypto";

const SALT_LEN = 16;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LEN).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, "hex");
    const actual = crypto.scryptSync(password, salt, KEY_LEN);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
