const { createHash } = require("node:crypto");

// Fingerprint of the retired plugin, with LF line endings. Never delete a modified copy.
const LEGACY_HASH = "72eac1d51812b24d899c97bda13153311bcac9b1237ee985a6a5f84f621a79ae";
function assertManagedLegacyQuestion(content, filePath) {
  const hash = createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
  if (hash !== LEGACY_HASH) throw new Error(`旧 OpenCode 提问插件已被修改，未自动删除：${filePath}。它可能覆盖原生 question 工具，请移走或检查该文件后重试。`);
}

module.exports = { assertManagedLegacyQuestion };
