const pty = require("node-pty");

let terminal;
let closing = false;
function send(message) {
  if (process.connected) process.send(message, () => {});
}
function close() {
  if (closing) return;
  closing = true;
  // Bound handle cleanup even when node-pty retains its ConPTY output worker.
  setTimeout(() => process.exit(0), 1500);
  try { terminal?.kill(); }
  catch (error) { send({ type: "data", data: `\r\n${error.message}\r\n` }); }
}
process.on("disconnect", close);
process.on("message", message => {
  if (closing) return;
  try {
    if (message.type === "spawn") {
      terminal = pty.spawn(message.file, message.args, message.options);
      terminal.onData(data => send({ type: "data", data }));
      terminal.onExit(({ exitCode }) => {
        send({ type: "exit", exitCode });
        closing = true;
        setTimeout(() => process.exit(0), 100);
      });
    } else if (message.type === "write") terminal?.write(message.data);
    else if (message.type === "resize") terminal?.resize(message.cols, message.rows);
    else if (message.type === "kill") close();
  } catch (error) {
    send({ type: "data", data: `\r\nHook 审核终端错误：${error.message}\r\n` });
    send({ type: "exit", exitCode: 1 });
    close();
  }
});
