const { mergeEnvironment } = require("../environment/index.cjs");

const bashQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const powershellQuote = value => `'${String(value).replace(/'/g, "''")}'`;

function readAuthMethods(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).flatMap(method => {
    if (!method || typeof method.id !== "string" || !method.id || seen.has(method.id)) return [];
    // OpenCode 2.0.18 advertises this legacy method without a terminal discriminator.
    const legacy = method.id === "opencode-login" && method.type == null;
    if (!legacy && method.type !== "terminal") return [];
    const args = legacy ? ["auth", "login"] : method.args ?? [];
    const env = legacy ? {} : method.env ?? {};
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0"))
      || !env || typeof env !== "object" || Array.isArray(env)
      || Object.entries(env).some(([name, value]) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)
        || typeof value !== "string" || value.includes("\0"))) return [];
    seen.add(method.id);
    return [{ id: method.id, name: typeof method.name === "string" ? method.name : method.id,
      description: typeof method.description === "string" ? method.description : "",
      args: [...args], env: { ...env } }];
  });
}

function buildAuthInvocation({ session, runtime, environment }, method) {
  const cwd = runtime.workspaceCwd || session.cwd;
  const env = mergeEnvironment([process.env, environment, method.env], session.type !== "wsl");
  const before = runtime.localBridge ? "" : String(session.initialCommand || "").trim();
  const bashCommand = `${before ? `{ ${before}; } 1>&2 && ` : ""}exec opencode ${method.args.map(bashQuote).join(" ")}`;
  if (session.type === "ssh" && !runtime.localBridge) {
    const exports = Object.entries({ ...environment, ...method.env }).map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error("无效的登录环境变量。");
      return `export ${name}=${bashQuote(value)}`;
    });
    return { remote: true, command: `bash -lic ${bashQuote([...exports, `cd ${bashQuote(cwd)}`, bashCommand].join(" && "))}` };
  }
  if (session.type === "wsl") {
    const inherited = String(env.WSLENV || "").split(":").filter(Boolean);
    const names = new Set(inherited.map(value => value.split("/")[0]));
    for (const name of Object.keys({ ...environment, ...method.env })) if (!names.has(name)) inherited.push(`${name}/u`);
    env.WSLENV = inherited.join(":");
    return { executable: "wsl.exe", args: ["-d", session.wslDistro, "--cd", cwd, "--", "bash", "-lic", bashCommand],
      cwd: process.cwd(), env };
  }
  const shell = runtime.shell || session.shell || "powershell.exe";
  const powershell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(shell);
  const login = `& opencode ${method.args.map(powershellQuote).join(" ")}; exit $LASTEXITCODE`;
  if (!powershell) {
    // Preserve CMD preparation (including PATH changes), without CMD interpreting descriptor arguments.
    const encoded = Buffer.from(login, "utf16le").toString("base64");
    return { executable: shell, args: ["/d", "/s", "/c",
      `${before ? `(${before}) && ` : ""}powershell.exe -NoLogo -NoProfile -EncodedCommand ${encoded}`], cwd, env };
  }
  const preparation = before ? `& { ${before} }; if (-not $?) { exit 1 }; ` : "";
  return { executable: shell, args: ["-NoLogo", "-NoProfile", "-Command", `${preparation}${login}`], cwd, env };
}

function createOpenCodeAuthService({ getContext, reconnect, broadcast, changed, sshAgentTransport,
  spawnTerminal = (...args) => require("node-pty").spawn(...args) }) {
  const jobs = new Map();
  let nextGeneration = 0;
  const active = job => job && ["running", "reconnecting"].includes(job.status);
  function snapshot(id) {
    const job = jobs.get(id);
    return job ? { status: job.status, generation: job.generation, error: job.error } : { status: "idle", generation: 0, error: null };
  }
  function update(id, job, status, error = null) {
    if (jobs.get(id) !== job) return;
    job.status = status; job.error = error;
    changed(id);
    broadcast("opencode-auth:state", { id, ...snapshot(id) });
  }
  async function start(id, methodId) {
    if (active(jobs.get(id))) throw new Error("OpenCode 登录正在进行。");
    const context = getContext(id);
    const method = context.authMethods.find(method => method.id === methodId);
    if (!method) throw new Error("当前 OpenCode 未提供此登录方式。");
    const job = { generation: ++nextGeneration, status: "running", error: null, term: null, history: "", seq: 0,
      disposables: [], context, abort: new AbortController() };
    jobs.set(id, job);
    update(id, job, "running");
    try {
      const invocation = buildAuthInvocation(context, method);
      const term = invocation.remote
        ? await sshAgentTransport.createInteractiveTransport(id, { command: invocation.command, actionName: "OpenCode login", signal: job.abort.signal })
        : spawnTerminal(invocation.executable, invocation.args, { cwd: invocation.cwd, env: invocation.env,
          name: "xterm-256color", cols: 100, rows: 24 });
      if (jobs.get(id) !== job || job.status !== "running") { term.kill(); return terminalSnapshot(job); }
      job.term = term;
      job.disposables.push(term.onData(data => {
        if (jobs.get(id) !== job || job.status !== "running") return;
        job.history = (job.history + String(data)).slice(-128000);
        broadcast("opencode-auth:data", { id, generation: job.generation, seq: ++job.seq, data: String(data) });
      }), term.onExit(({ exitCode, signal, reason }) => {
        if (jobs.get(id) !== job || job.status !== "running") return;
        dispose(job, false);
        if (exitCode !== 0 || signal || reason && reason !== "remote-exit") {
          update(id, job, "failed", `OpenCode 登录未完成（退出代码 ${exitCode ?? "未知"}）。`);
          return;
        }
        update(id, job, "reconnecting");
        Promise.resolve().then(() => reconnect(id, context)).then(() => {
          update(id, job, "succeeded");
        }).catch(error => update(id, job, "failed", `登录后重连失败：${error.message}`));
      }));
      return terminalSnapshot(job);
    } catch (error) {
      dispose(job); update(id, job, "failed", error.message); throw error;
    }
  }
  function terminalSnapshot(job) { return { generation: job.generation, history: job.history, seq: job.seq }; }
  function dispose(job, kill = true) {
    job.abort.abort();
    for (const disposable of job.disposables.splice(0)) disposable?.dispose();
    if (kill) job.term?.kill();
    job.term = null;
  }
  function cancel(id, generation) {
    const job = jobs.get(id);
    if (!job || generation != null && job.generation !== generation || job.status !== "running") return;
    update(id, job, "cancelled"); dispose(job);
  }
  function close(id) {
    const job = jobs.get(id);
    jobs.delete(id);
    if (job) dispose(job);
  }
  function write(id, generation, data) {
    const job = jobs.get(id);
    if (job?.generation === generation && job.status === "running" && typeof data === "string" && data.length <= 65536) job.term?.write(data);
  }
  function resize(id, generation, cols, rows) {
    const job = jobs.get(id);
    if (job?.generation === generation && job.status === "running" && Number.isInteger(cols) && Number.isInteger(rows)
      && cols > 0 && rows > 0 && cols <= 500 && rows <= 300) job.term?.resize(cols, rows);
  }
  return { start, cancel, close, write, resize, snapshot, isActive: id => active(jobs.get(id)),
    shutdown() { for (const id of jobs.keys()) close(id); } };
}

module.exports = { readAuthMethods, buildAuthInvocation, createOpenCodeAuthService };
