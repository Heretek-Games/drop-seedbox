import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * At-rest encryption for seedbox credentials.
 *
 * qBittorrent credentials must be stored in plugin storage to authenticate
 * during progress polling, so they are encrypted with a key supplied by the
 * host environment rather than persisted in plaintext. The key never lives in
 * storage, so a database-only leak does not expose the credentials.
 */
export const SEEDBOX_CONFIG_KEY_ENV = "DROP_SEEDBOX_CONFIG_KEY";

const ALGO = "aes-256-gcm";
const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

function decodeKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === KEY_BYTES) return decoded;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Load the encryption key from the environment. Returns `null` when unset and
 * throws when set but malformed (a misconfiguration should not fall back to
 * plaintext silently).
 */
export function loadConfigKey(
  env: NodeJS.ProcessEnv = process.env,
): Buffer | null {
  const raw = env[SEEDBOX_CONFIG_KEY_ENV];
  if (!raw) return null;
  const key = decodeKey(raw);
  if (!key) {
    throw new Error(
      `${SEEDBOX_CONFIG_KEY_ENV} must be a 32-byte key encoded as 64 hex characters or base64`,
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string, key: Buffer): string {
  const [version, ivB64, tagB64, ciphertextB64] = payload.split(":");
  if (version !== VERSION || !ivB64 || !tagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted seedbox secret");
  }
  const decipher = createDecipheriv(
    ALGO,
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
