const http = require("node:http");
const https = require("node:https");

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        },
        timeout: 2000
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Claude hook POST timed out"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  const hookUrl = process.env.PANNEL_HANDLE_HOOK_URL;
  if (!hookUrl) {
    return;
  }

  const stdin = await readStdin();
  let payload = {};
  try {
    payload = stdin ? JSON.parse(stdin) : {};
  } catch (err) {
    payload = { parse_error: String(err), raw_input: stdin };
  }

  await postJson(hookUrl, {
    cwd: process.cwd(),
    pannel_handle_session_id: process.env.PANNEL_HANDLE_SESSION_ID,
    ...payload
  });
})().catch((err) => {
  console.error(err.message || err);
});
