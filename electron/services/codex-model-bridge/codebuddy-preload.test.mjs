import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = path.dirname(fileURLToPath(import.meta.url));
const preloadFile = path.join(directory, "codebuddy-preload.cjs");

describe("CodeBuddy Codex preload", () => {
  it("reroutes only the authenticated model request to the local bridge", async () => {
    let captured;
    const server = http.createServer((request, response) => {
      captured = { url: request.url, headers: request.headers };
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const script = [
      "const https = require('node:https');",
      "const request = https.request('https://copilot.tencent.com/chat/completions', { method: 'POST', headers: { authorization: 'Bearer provider-secret' } }, response => { response.resume(); response.on('end', () => process.exit(0)); });",
      "request.on('error', error => { process.stderr.write(error.message); process.exit(1); });",
      "request.end('{}');"
    ].join("");
    const child = spawn(process.execPath, ["-e", script], {
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${JSON.stringify(preloadFile)}`,
        PANNEL_HANDLE_CODEBUDDY_BRIDGE_URL: `http://127.0.0.1:${port}`,
        PANNEL_HANDLE_CODEBUDDY_BRIDGE_TOKEN: "internal-secret",
        PANNEL_HANDLE_CODEBUDDY_REQUEST_ID: "request-1"
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const exitCode = await new Promise(resolve => child.on("exit", resolve));
    await new Promise(resolve => server.close(resolve));

    expect(exitCode, stderr).toBe(0);
    expect(captured.url).toBe("/internal/codebuddy/request-1");
    expect(captured.headers.authorization).toBe("Bearer provider-secret");
    expect(captured.headers["x-pannel-bridge-token"]).toBe("internal-secret");
    expect(captured.headers["x-pannel-upstream-url"]).toBe("https://copilot.tencent.com/chat/completions");
  });
});
