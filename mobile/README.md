# Pannel Handle Mobile

Pannel Handle 的 Android Chrome 局域网移动终端。它不在手机上创建 shell，而是通过桌面应用提供的 HTTP/WebSocket 服务查看和控制同一个 PTY。

## 开发与验证

```powershell
# 在仓库根目录执行
corepack pnpm install
corepack pnpm test:mobile
corepack pnpm build:mobile
corepack pnpm dev:mobile
```

生产环境由同一仓库中的 Electron 应用提供 `mobile/dist` 静态资源。根目录的测试、构建和打包命令会统一处理桌面端与移动端；`mobile/dist/build-manifest.json` 的 `protocolVersion` 必须与桌面端一致。

当前 v1 使用局域网 HTTP 明文传输，只能用于可信私人网络，不能映射到互联网。
