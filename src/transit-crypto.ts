import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts { rut, password } into a single base64 blob.
 * Format: base64(iv[12] || ciphertext || authTag[16])
 */
export function encryptCredentials(
  rut: string,
  password: string,
  transitKey: string,
): string {
  const key = Buffer.from(transitKey, "hex");
  const iv = crypto.randomBytes(IV_LENGTH);
  const payload = JSON.stringify({ rut, password });

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(payload, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
}

/**
 * Decrypts a base64 blob produced by encryptCredentials.
 */
export function decryptCredentials(
  encryptedPayload: string,
  transitKey: string,
): { rut: string; password: string } {
  const key = Buffer.from(transitKey, "hex");
  const buf = Buffer.from(encryptedPayload, "base64");

  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf8")) as { rut: string; password: string };
}
