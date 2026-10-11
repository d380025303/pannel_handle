// Source-only checks never execute project code. Findings are suggestions for review,
// not proof that a runtime failure has been reproduced.
function checkSources(sources) {
  const findings = [];
  for (const [file, source] of sources) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const lines = source.split(/\r?\n/);
    const rules = [
      { id: "electron-node-integration", pattern: /\bnodeIntegration\s*:\s*true\b/, severity: "P1", title: "窗口启用了 Node 集成，需要复核信任边界", observation: "源码设置 nodeIntegration: true；若加载不可信内容可能暴露 Node 能力。", recommendation: "核实该窗口加载内容及隔离配置，优先改为受控 preload API 并补充窗口安全测试。" },
      { id: "electron-context-isolation", pattern: /\bcontextIsolation\s*:\s*false\b/, severity: "P1", title: "窗口关闭了上下文隔离", observation: "源码明确关闭 contextIsolation，需要核实页面与 preload 之间的信任边界。", recommendation: "复核兼容性后启用上下文隔离，通过 contextBridge 暴露最小能力。" },
      { id: "tls-verification-disabled", pattern: /\brejectUnauthorized\s*:\s*false\b/, severity: "P1", title: "TLS 证书验证被关闭", observation: "连接配置允许未经验证的 TLS 证书；需确认是否仅用于明确授权的本地测试。", recommendation: "检查连接目标和配置入口，使用可信 CA；如需例外，限定目标并明确用户授权。" },
      { id: "empty-error-handler", pattern: /\bcatch\s*\([^)]*\)\s*\{\s*\}/, severity: "P2", title: "异常被空处理器吞掉", observation: "存在空 catch 处理器，可能隐藏失败或遗漏恢复；需结合调用方复核。", recommendation: "复核该异常是否预期，补充可观察的错误反馈、恢复路径或说明，并覆盖失败测试。" }
    ];
    lines.forEach((line, index) => {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      for (const rule of rules) {
        const match = line.match(rule.pattern);
        if (!match) continue;
        findings.push({ title: rule.title, ruleId: rule.id, severity: rule.severity, type: "suspected", confidence: 0.65,
          location: { path: file, startLine: index + 1 }, anchor: match[0], observations: [rule.observation], recommendation: rule.recommendation });
      }
    });
  }
  return findings;
}
module.exports = { checkSources };
