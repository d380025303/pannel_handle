const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { app, safeStorage } = require("electron");
const { createQoderAuthWasm } = require("./qoder-auth-wasm.cjs");

const OUTPUT_PREFIX = "PANNEL_HANDLE_QODER_ACTIVITY:";
const ACTIVITY_PATH = "/algo/api/v2/activity";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findQoderCliRoot() {
  const candidates = [];
  if (process.env.QODER_CLI_ROOT) candidates.push(process.env.QODER_CLI_ROOT);
  const where = spawnSync("where.exe", ["qoder.cmd"], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
  for (const commandPath of String(where.stdout || "").split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
    candidates.push(path.join(path.dirname(commandPath), "node_modules", "@qoder-ai", "qodercli"));
  }
  candidates.push(
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@qoder-ai", "qodercli"),
    path.join(process.env.LOCALAPPDATA || "", "pnpm", "global", "5", "node_modules", "@qoder-ai", "qodercli")
  );
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(path.join(candidate, "bundle", "qoder-worker-runtime.mjs"))) return candidate;
  }
  throw new Error("Qoder CLI authentication runtime was not found.");
}

function findQoderIdeVersion(sharedCachePath) {
  try {
    const version = String(readJson(path.join(sharedCachePath, "cache", "status.json")).version || "").trim();
    if (version) return version;
  } catch {}
  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Qoder IDE", "resources", "app", "package.json"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Qoder", "resources", "app", "package.json")
  ];
  for (const candidate of candidates) {
    try {
      const version = String(readJson(candidate).version || "").trim();
      if (version) return version;
    } catch {}
  }
  return "1.0.0";
}

function readQoderIdeUserInfo(qoderUserDataPath) {
  const { DatabaseSync } = require("node:sqlite");
  const databasePath = path.join(qoderUserDataPath, "User", "globalStorage", "state.vscdb");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  let row;
  try {
    row = database.prepare("select value from ItemTable where key = ?").get("secret://aicoding.auth.userInfo");
  } finally {
    database.close();
  }
  if (!row?.value) throw new Error("Qoder IDE login information is unavailable.");
  const stored = JSON.parse(row.value);
  if (!Array.isArray(stored?.data)) throw new Error("Qoder IDE login information has an unsupported format.");
  const value = safeStorage.decryptString(Buffer.from(stored.data));
  const userInfo = JSON.parse(value);
  if (!userInfo?.id || !userInfo?.token) throw new Error("Qoder IDE is not signed in.");
  return userInfo;
}

function readInferenceEndpoint(sharedCachePath) {
  try {
    const cache = readJson(path.join(sharedCachePath, "cache", "cache.json"));
    const endpoint = String(cache?.regionConfig?.preferredInferenceNode?.endpoint || "").trim();
    if (/^https:\/\//iu.test(endpoint)) return endpoint.replace(/\/$/u, "");
  } catch {}
  return "https://api1.qoder.sh";
}

async function fetchQoderActivities() {
  const qoderUserDataPath = path.join(process.env.APPDATA || "", "Qoder");
  const sharedCachePath = path.join(qoderUserDataPath, "SharedClientCache");
  const cliRoot = findQoderCliRoot();
  const auth = createQoderAuthWasm(path.join(cliRoot, "bundle", "qoder-worker-runtime.mjs"));
  const cliHome = path.join(process.env.USERPROFILE || "", ".qoder", ".auth");
  const cliMachineId = fs.readFileSync(path.join(cliHome, "machine_id"), "utf8").trim();
  const cliCiphertext = fs.readFileSync(path.join(cliHome, "user"), "utf8").trim();
  const baseUserInfo = JSON.parse(auth.decryptCredential(cliCiphertext, cliMachineId.slice(0, 16)));
  const ideUserInfo = readQoderIdeUserInfo(qoderUserDataPath);
  const ideMachineId = fs.readFileSync(path.join(sharedCachePath, "cache", "id"), "utf8").trim();
  const ideMachineInfo = readJson(path.join(sharedCachePath, "cache", "machine_token.json"));
  if (!ideMachineInfo?.token || !ideMachineInfo?.type) throw new Error("Qoder IDE machine information is unavailable.");

  const userInfo = {
    ...baseUserInfo,
    uid: ideUserInfo.id,
    security_oauth_token: ideUserInfo.token,
    access_token: ideUserInfo.token,
    data_policy_agreed: ideUserInfo.privacyPolicyAgreed
  };
  Object.assign(userInfo, auth.generateRuntimeAuthFields(userInfo));
  const version = findQoderIdeVersion(sharedCachePath);
  const context = auth.createContext(ideMachineId, version, userInfo);
  try {
    const request = auth.prepareRequest(context, {
      endpoint: readInferenceEndpoint(sharedCachePath),
      path: ACTIVITY_PATH,
      headers: { "Accept-Language": app.getLocale().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US" }
    });
    request.headers["Cosy-MachineToken"] = ideMachineInfo.token;
    request.headers["Cosy-MachineType"] = ideMachineInfo.type;
    request.headers["Cosy-MachineOS"] = `${process.arch === "arm64" ? "aarch64" : "x86_64"}_windows`;
    request.headers["Cosy-ClientType"] = "0";
    request.headers["Cosy-Version"] = version;
    const response = await fetch(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(8_000)
    });
    const responseText = auth.decryptServerResponse(await response.text());
    if (!response.ok) throw new Error(`Qoder activity request failed with status ${response.status}.`);
    const payload = JSON.parse(responseText);
    if (payload?.code !== 0) throw new Error("Qoder activity request returned an unsuccessful response.");
    return { activities: Array.isArray(payload?.data?.activities) ? payload.data.activities : [] };
  } finally {
    auth.freeContext(context);
  }
}

async function runQoderActivityHelper() {
  const qoderUserDataPath = path.join(process.env.APPDATA || "", "Qoder");
  app.setPath("userData", qoderUserDataPath);
  await app.whenReady();
  try {
    const result = await fetchQoderActivities();
    process.stdout.write(`${OUTPUT_PREFIX}${JSON.stringify(result)}\n`, () => app.exit(0));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Qoder activity quota is unavailable."}\n`);
    app.exit(1);
  }
}

module.exports = {
  OUTPUT_PREFIX,
  fetchQoderActivities,
  findQoderCliRoot,
  readInferenceEndpoint,
  runQoderActivityHelper
};
