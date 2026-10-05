const { readCredentials } = require("./credentials.cjs");
const BASE = "https://openapi.qoder.sh";
const API = "/sash/api/v1/me/campaigns";
const WINDOW_MS = 86400000;

function windowStart(now) {
  return Math.floor((now - 7200000) / WINDOW_MS) * WINDOW_MS + 7200000;
}

function failure(message, code, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function normalizeStatus(payload, credentials, now) {
  if (!Array.isArray(payload?.campaigns)) throw failure("Qoder returned an invalid campaign response.", "invalid-response", true);
  const start = windowStart(now);
  const candidates = payload.campaigns.filter(c => c.actionType === "CLAIM_BENEFIT"
    && c.benefit?.kind === "CREDITS" && c.benefit.amount === 100
    && c.benefit.validity?.mode === "RELATIVE_DAYS" && c.benefit.validity.days === 30
    && c.startAt * 1000 === start && c.endAt * 1000 > now && c.endAt * 1000 <= start + WINDOW_MS);
  if (candidates.length > 1) throw failure("Cannot uniquely identify Qoder daily reward.", "ambiguous-campaign");
  const c = candidates[0];
  if (c && (typeof c.campaignId !== "string" || !c.campaignId || typeof c.claimStatus !== "string")) {
    throw failure("Unsupported Qoder daily reward response.", "invalid-response");
  }
  return {
    accountId: credentials.accountId, accountLabel: credentials.accountLabel,
    active: !!c, claimable: c?.claimStatus === "CLAIMABLE", todayCheckedIn: c?.claimStatus === "CLAIMED",
    dailyCredit: c?.benefit.amount || 0, windowStart: start, nextClaimAt: start + WINDOW_MS, campaignId: c?.campaignId
  };
}

function createQoderCheckinService({ getCredentials = readCredentials, fetchFn = fetch, now = Date.now } = {}) {
  let inFlight = null;
  async function request(credentials, suffix = "", method = "GET") {
    let response;
    try {
      response = await fetchFn(BASE + API + suffix, {
        method, headers: { Accept: "application/json", Authorization: `Bearer ${credentials.token}`,
          "Cosy-ClientType": "10", "Cosy-Version": "0.4.3", "User-Agent": "Qoder" },
        signal: AbortSignal.timeout(15000)
      });
    } catch { throw failure("Qoder check-in request failed or timed out.", "network", true); }
    if (!response.ok) throw failure(response.status === 401 || response.status === 403
      ? "Qoder login expired or reward requires desktop device verification. Please open Qoder."
      : `Qoder check-in returned HTTP ${response.status}.`, "http-error", response.status >= 500 || response.status === 429);
    if (method === "POST") { await response.body?.cancel(); return; }
    let text;
    try {
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) { await reader.cancel(); throw failure("Qoder response exceeded the size limit.", "response-too-large"); }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (error.code === "response-too-large") throw error;
      throw failure("Qoder check-in response could not be read.", "network", true);
    }
    try { return JSON.parse(text); } catch { throw failure("Qoder returned an invalid response.", "invalid-response", true); }
  }
  async function status(credentials) { return normalizeStatus(await request(credentials), credentials, now()); }
  async function getStatus() { return status(await getCredentials()); }
  async function performClaim() {
    const credentials = await getCredentials();
    const current = await status(credentials);
    if (current.todayCheckedIn) return { alreadyCheckedIn: true, status: current };
    if (!current.active || !current.claimable) throw failure("Qoder daily reward is not available.", "activity-inactive");
    const beforeClaim = await getCredentials();
    if (beforeClaim.accountId !== credentials.accountId) throw failure("Qoder desktop account changed. Please retry.", "account-changed");
    if (windowStart(now()) !== current.windowStart) throw failure("Qoder reward window changed. Please retry.", "window-changed", true);
    let claimError;
    try { await request(beforeClaim, `/${encodeURIComponent(current.campaignId)}/claim`, "POST"); }
    catch (error) { claimError = error; }
    const latestCredentials = await getCredentials();
    if (latestCredentials.accountId !== credentials.accountId) throw failure("Qoder desktop account changed. Please retry.", "account-changed");
    const updated = await status(latestCredentials);
    if (updated.campaignId === current.campaignId && updated.todayCheckedIn) return { alreadyCheckedIn: false, status: updated };
    if (claimError) throw claimError;
    throw failure("Qoder reward has not been confirmed. Please retry the status query.", "claim-unconfirmed", true);
  }
  return {
    getStatus,
    claim() {
      if (!inFlight) inFlight = performClaim().finally(() => { inFlight = null; });
      return inFlight;
    }
  };
}

module.exports = { createQoderCheckinService, normalizeStatus, windowStart };
