const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const SERVICE = "gemini-cli-oauth";
const ACCOUNT = "main-account";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function readGeminiOAuthClient() {
  const globalRoot = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", timeout: 3000, windowsHide: true }).trim();
  const bundleRoot = path.join(globalRoot, "@google", "gemini-cli", "bundle");
  for (const name of fs.readdirSync(bundleRoot)) {
    if (!name.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(bundleRoot, name), "utf8");
    const clientId = source.match(/\bOAUTH_CLIENT_ID\s*=\s*["']([^"']+)["']/)?.[1];
    const clientSecret = source.match(/\bOAUTH_CLIENT_SECRET\s*=\s*["']([^"']+)["']/)?.[1];
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  throw new Error("Gemini CLI OAuth configuration is unavailable.");
}

function credentialFromValue(value) {
  if (typeof value === "string") {
    try { return credentialFromValue(JSON.parse(value)); } catch { return null; }
  }
  const token = value?.token || value;
  if (!token || typeof token !== "object") return null;
  return {
    accessToken: token.accessToken || token.access_token,
    refreshToken: token.refreshToken || token.refresh_token,
    expiresAt: Number(token.expiresAt || token.expiry_date || 0)
  };
}

function readEncryptedCredential(home) {
  const file = path.join(home, ".gemini", "gemini-credentials.json");
  if (!fs.existsSync(file)) return null;
  const [ivHex, tagHex, cipherHex] = fs.readFileSync(file, "utf8").trim().split(":");
  if (!ivHex || !tagHex || !cipherHex) return null;
  const salt = `${os.hostname()}-${os.userInfo().username}-gemini-cli`;
  const key = crypto.scryptSync("gemini-cli-oauth", salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"), { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plain = decipher.update(cipherHex, "hex", "utf8") + decipher.final("utf8");
  const data = JSON.parse(plain);
  return credentialFromValue(data?.[SERVICE]?.[ACCOUNT]);
}

async function readKeychainCredential() {
  try {
    const globalRoot = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", timeout: 3000, windowsHide: true }).trim();
    const keytarPath = require.resolve("@github/keytar", { paths: [globalRoot, path.join(globalRoot, "@google", "gemini-cli")] });
    const keytar = require(keytarPath);
    return credentialFromValue(await keytar.getPassword(SERVICE, ACCOUNT));
  } catch { return null; }
}

async function readCredential(home) {
  const keychain = await readKeychainCredential();
  if (keychain?.accessToken || keychain?.refreshToken) return keychain;
  try {
    const encrypted = readEncryptedCredential(home);
    if (encrypted?.accessToken || encrypted?.refreshToken) return encrypted;
  } catch { /* report a generic unavailable error below */ }
  return credentialFromValue(readJson(path.join(home, ".gemini", "oauth_creds.json")));
}

async function requestJson(url, options, signal) {
  const response = await fetch(url, { ...options, signal });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("Gemini quota response is too large.");
  if (!response.ok) throw new Error(`Gemini quota request failed (${response.status}).`);
  try { return JSON.parse(text); } catch { throw new Error("Gemini quota returned invalid JSON."); }
}

async function getAccessToken(credential, signal) {
  if (credential.accessToken && credential.expiresAt > Date.now() + 5 * 60 * 1000) return credential.accessToken;
  if (!credential.refreshToken) throw new Error("Gemini OAuth credentials are unavailable.");
  const { clientId, clientSecret } = readGeminiOAuthClient();
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: credential.refreshToken, grant_type: "refresh_token" });
  const result = await requestJson("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, signal);
  if (!result.access_token) throw new Error("Gemini OAuth refresh did not return an access token.");
  return result.access_token;
}

async function main() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const home = process.env.GEMINI_CLI_HOME || os.homedir();
    const settings = readJson(path.join(home, ".gemini", "settings.json")) || {};
    if (settings?.security?.auth?.selectedType !== "oauth-personal") throw new Error("Gemini quota is only available for Login with Google authentication.");
    const credential = await readCredential(home);
    if (!credential) throw new Error("Gemini OAuth credentials are unavailable.");
    const accessToken = await getAccessToken(credential, controller.signal);
    const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": "Pannel-Handle" };
    const base = "https://cloudcode-pa.googleapis.com/v1internal";
    const projectHint = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;
    const metadata = { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI", ...(projectHint ? { duetProject: projectHint } : {}) };
    const load = await requestJson(`${base}:loadCodeAssist`, { method: "POST", headers, body: JSON.stringify({ ...(projectHint ? { cloudaicompanionProject: projectHint } : {}), metadata }) }, controller.signal);
    const project = load.cloudaicompanionProject || projectHint;
    if (!project) throw new Error("Gemini Code Assist project is unavailable.");
    const quota = await requestJson(`${base}:retrieveUserQuota`, { method: "POST", headers, body: JSON.stringify({ project }) }, controller.signal);
    const buckets = (Array.isArray(quota.buckets) ? quota.buckets : []).flatMap(bucket => {
      const remainingFraction = Number(bucket?.remainingFraction);
      if (!bucket?.modelId || !Number.isFinite(remainingFraction)) return [];
      const remainingAmount = Number(bucket.remainingAmount);
      return [{ modelId: String(bucket.modelId), remainingFraction: Math.min(1, Math.max(0, remainingFraction)), ...(Number.isFinite(remainingAmount) ? { remainingAmount } : {}), ...(bucket.resetTime ? { resetTime: String(bucket.resetTime) } : {}) }];
    });
    process.stdout.write(JSON.stringify({ ok: true, buckets }));
  } catch (error) {
    const message = error?.name === "AbortError" ? "Reading Gemini quota timed out." : error instanceof Error ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  } finally { clearTimeout(timer); }
}

void main();
