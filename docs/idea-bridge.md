# IDEA 项目运行控制

Pannel Handle 可以通过配套的 **Pannel Handle Bridge** 插件，列出本机 IntelliJ IDEA 中已经保存的 Run/Debug Configuration，并控制它们的运行、调试、停止和重启。进程仍由 IDEA 管理，输出也继续显示在 IDEA 的 Run/Debug 工具窗口中。

## 兼容范围

- IntelliJ IDEA Community/Ultimate 2025.2，build `252.*`
- Windows 本机 IDEA；不控制远程开发后端
- 首版不负责启动、关闭或自动安装 IDEA

## 构建与安装插件

1. 启动本机 IDEA 2025.2，或设置环境变量 `PANNEL_HANDLE_IDEA_HOME` 指向 IDEA 安装目录。
2. 在仓库根目录执行：

   ```powershell
   pnpm idea:plugin:build
   ```

3. 在 IDEA 中打开 `Settings | Plugins`，选择齿轮菜单的 `Install Plugin from Disk`。
4. 选择 `idea-plugin\build\distributions` 中生成的 ZIP，安装后重启 IDEA。
5. 启动 Pannel Handle，打开右侧的 `IDEA` 页签。

构建脚本使用 IDEA 自带的 JetBrains Runtime，并把临时 Gradle 分发包缓存到 `node_modules\.cache`，不会修改 IDEA 安装目录。

## 工作方式与安全边界

- 插件只监听 `127.0.0.1` 上的随机端口，不开放局域网访问。
- 每个 IDEA 进程生成独立的随机认证令牌和发现文件。发现目录位于 `%LOCALAPPDATA%\Pannel Handle\idea-bridge\instances`，插件会尽力把目录和文件 ACL 限制为当前 Windows 用户。
- 认证令牌只由 Electron 主进程读取，不会通过 preload 传给 React 页面。
- Pannel Handle 通过 IDEA 的公开 Execution API 操作运行配置，不扫描命令行，也不会使用 `taskkill` 强制终止 IDEA 或其项目进程。
- 停止操作遵循 IDEA `ProcessHandler` 的正常终止流程；目标进程拒绝退出时，应回到 IDEA 的 Run/Debug 工具窗口处理。

## 行为说明

- IDEA 内手动启动的实例也会显示在 Pannel Handle 中。
- 允许并行运行的配置可以创建多个实例，并支持逐实例停止或重启。
- 不允许并行运行的配置在已有实例时会禁用 Run/Debug 按钮。
- Compound Configuration 的启动交给 IDEA；其产生的实际子进程显示在对应子配置下。
- 同时运行多个 IDEA 进程或打开多个项目时，面板会分别分组展示。

## 排查

- 面板显示“未连接到 IDEA”：确认插件已启用并在安装后重启了 IDEA。
- 显示版本不兼容：确认 IDEA build 为 `252.*`，重新构建匹配版本的插件。
- 配置没有出现：确认它是 IDEA 中已保存并至少支持 Run 或 Debug 的配置。
- 操作失败：先在 IDEA 内直接运行同一配置，检查 SDK、Before Launch Task 和配置校验错误。
