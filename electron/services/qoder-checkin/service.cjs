const { readCredentials } = require("./credentials.cjs");
const { createDeviceContextReader } = require("./device-context.cjs");
const { createQoderDesktopClient, failure } = require("./desktop-client.cjs");
const API = "/sash/api/v1/me/campaigns";
const WINDOW_MS = 86400000;

function windowStart(now) {
  return Math.floor((now - 7200000) / WINDOW_MS) * WINDOW_MS + 7200000;
}

function normalizeStatus(payload, credentials, now) {
  if (!Array.isArray(payload?.campaigns)) throw failure("Qoder returned an invalid campaign response.", "invalid-response", true);
  if (typeof payload.uid === "string" && payload.uid !== credentials.accountId) {
    throw failure("Qoder desktop account changed. Please retry.", "account-changed");
  }
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

function createQoderCheckinService({ getCredentials = readCredentials, fetchFn = fetch, now = Date.now,
  getRequestHeaders = createDeviceContextReader() } = {}) {
  let inFlight = null;
  let claimAccountId;
  const client = createQoderDesktopClient({ getCredentials, fetchFn });
  async function request(credentials, suffix = "", method = "GET") {
    const deviceHeaders = await getRequestHeaders(credentials);
    await client.credentials(credentials.accountId);
    return client.request(credentials, API + suffix, { method, headers: deviceHeaders });
  }
  async function status(credentials) {
    const payload = await request(credentials);
    await client.credentials(credentials.accountId);
    return normalizeStatus(payload, credentials, now());
  }
  async function getStatus(expectedAccountId) { return status(await client.credentials(expectedAccountId)); }
  async function performClaim(expectedAccountId) {
    const credentials = await client.credentials(expectedAccountId);
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
    claim(expectedAccountId) {
      if (inFlight && expectedAccountId !== claimAccountId) {
        return Promise.reject(failure("Qoder desktop account changed. Please retry.", "account-changed"));
      }
      if (!inFlight) {
        claimAccountId = expectedAccountId;
        inFlight = performClaim(expectedAccountId).finally(() => { inFlight = null; claimAccountId = undefined; });
      }
      return inFlight;
    }
  };
}

module.exports = { createQoderCheckinService, normalizeStatus, windowStart };
