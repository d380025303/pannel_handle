const { readCredentials } = require("./credentials.cjs");

const BASE = "https://openapi.qoder.sh";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function failure(message, code, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function assertAccount(credentials, expectedAccountId) {
  if (expectedAccountId !== undefined && credentials.accountId !== expectedAccountId) {
    throw failure("Qoder desktop account changed. Please refresh quota and retry.", "account-changed");
  }
}

function createQoderDesktopClient({ getCredentials = readCredentials, fetchFn = fetch } = {}) {
  async function request(credentials, apiPath, { method = "GET", headers = {}, signal, timeoutMs = 15000 } = {}) {
    let response;
    try {
      response = await fetchFn(BASE + apiPath, {
        method, redirect: "error",
        headers: { ...headers, Accept: "application/json", Authorization: `Bearer ${credentials.token}`,
          "Cosy-ClientType": "10", "User-Agent": "Qoder" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      });
    } catch { throw failure("Qoder request failed or timed out.", "network", true); }
    if (!response.ok) {
      await response.body?.cancel();
      throw failure(response.status === 401 || response.status === 403
        ? "Qoder login expired or reward requires desktop device verification. Please open Qoder."
        : `Qoder returned HTTP ${response.status}.`,
      response.status === 401 || response.status === 403 ? "authentication" : "http-error",
      response.status >= 500 || response.status === 429);
    }
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
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure("Qoder response exceeded the size limit.", "response-too-large"); }
        chunks.push(Buffer.from(value));
      }
      text = Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (error.code === "response-too-large") throw error;
      throw failure("Qoder response could not be read.", "network", true);
    }
    try { return JSON.parse(text); } catch { throw failure("Qoder returned an invalid response.", "invalid-response", true); }
  }
  async function credentials(expectedAccountId) {
    const value = await getCredentials();
    assertAccount(value, expectedAccountId);
    return value;
  }
  return { credentials, request };
}

module.exports = { createQoderDesktopClient, failure, assertAccount };
