const crypto = require("node:crypto");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);

async function encryptPortable(secret, passphrase) {
  if (!secret) return null;
  if (!passphrase) throw new Error("Backup passphrase is required for SSH credentials.");
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const key = await scrypt(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { version: 1, salt: salt.toString("base64"), nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

async function decryptPortable(payload, passphrase) {
  if (!payload) return undefined;
  if (payload.version !== 1 || !passphrase) throw new Error("Backup passphrase is required.");
  try {
    const key = await scrypt(passphrase, Buffer.from(payload.salt, "base64"), 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.nonce, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(payload.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Backup passphrase is incorrect or the SSH credential is damaged.");
  }
}

module.exports = { encryptPortable, decryptPortable };
