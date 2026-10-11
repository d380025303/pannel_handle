const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createProfiler } = require("./project-profiler.cjs");
const { createSshSessionRuntime } = require("../../ssh/ssh-session-runtime.cjs");
const execute = promisify(execFile);
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
function createEnvironmentProfiler({ sessionStore, knownHostStore, executeProcess = execute, runtimeFactory = createSshSessionRuntime }) {
  return project => {
    const config = project.templateSnapshot;
    if (!config || config.type === "windows") return require("./project-profiler.cjs");
    if (!["wsl", "ssh"].includes(config.type)) throw new Error("不支持的项目环境。");
    if (config.type === "ssh" && config.sshConfig?.remotePlatform === "windows") throw new Error("远程 Windows Git 执行器尚未接入。请选择 Linux SSH 模板。");
    const runtime = config.type === "ssh" ? runtimeFactory({ sessionStore, knownHostStore, terminalManager: { getSession: () => config } }) : null;
    async function run(root, args, options) {
      if (typeof root !== "string" || !root.startsWith("/") || root.includes("\0")) throw new Error("远程工作目录必须是绝对路径。");
      options?.signal?.throwIfAborted();
      const command = "cd -- " + quote(root) + " && GIT_TERMINAL_PROMPT=0 GIT_NO_REPLACE_OBJECTS=1 git " + args.map(quote).join(" ");
      const output = runtime ? await runtime.exec("inspector", command, { timeoutMs: 30000, signal: options?.signal, allowExitCodes: options?.allowExitCodes })
        : (await executeProcess("wsl.exe", [...(config.wslDistro ? ["-d", config.wslDistro] : []), "--exec", "sh", "-c", command], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: options?.maxBuffer || 16 * 1024 * 1024, signal: options?.signal })).stdout;
      const stdout = typeof output === "string" ? output : output.stdout;
      if (typeof stdout !== "string" || Buffer.byteLength(stdout) > (options?.maxBuffer || 16 * 1024 * 1024)) throw new Error("远程 Git 输出无效或超过读取上限。");
      return stdout;
    }
    async function git(root, args, options) {
      let keys;
      try { keys = await run(root, ["--no-optional-locks", "config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"], { ...options, allowExitCodes: [0, 1] }); }
      catch (error) { if (error.code !== 1 && error.exitCode !== 1) throw error; keys = ""; }
      const names = [...new Set(keys.split(/\r?\n/).filter(Boolean))];
      if (names.some(key => !/^filter\.[^=\x00-\x1f]+\.(clean|smudge|process|required)$/.test(key))) throw new Error("Git 过滤器配置无法安全解析。");
      return run(root, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=", ...names.flatMap(key => ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`]), ...args], options);
    }
    return createProfiler({ git, remote: true });
  };
}
module.exports = { createEnvironmentProfiler, quote };
