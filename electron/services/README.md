# 主进程服务边界

`main.cjs` 负责装配服务与注入桌面能力；服务内部不直接获取 Electron 窗口、IPC 或全局服务实例。现有 IPC 名称、调用参数和数据格式保持不变。

## 本次规整的领域

| 目录 | 入口与职责 | 状态及资源所有者 |
| --- | --- | --- |
| `conversation-history/` | `index.cjs` 导出历史查询工厂和转录解析器；本地厂商读取器、分页规则、远程 Python 执行分离 | 查询服务持有 CodeBuddy 元数据缓存；远程读取器管理 WSL 子进程超时，SSH 使用注入的 transport |
| `project-search/` | `index.cjs` 导出搜索工厂；路径、匹配、遍历、ripgrep 与文本回退各自独立 | 服务持有按会话区分的搜索任务；执行器通过任务关联子进程并清理定时器 |
| `mobile-remote/` | `index.cjs` 导出移动访问工厂；HTTP、鉴权、尺寸交接、消息路由分离 | 服务管理 HTTP/WebSocket、发现服务和心跳；鉴权组件管理配对、认证尝试和重连宽限；尺寸组件管理会话尺寸所有权 |
| `workbuddy/` | `index.cjs` 导出签到、自动签到、模型目录、目录计算和用户信息查询能力 | ACP transport 管理子进程；用户信息客户端负责请求结束时关闭 transport；自动签到服务管理调度 |
| `clipboard/` | `index.cjs` 导出剪贴板图片服务 | 临时图片和目标会话操作遵循原有逻辑 |
| `launch-templates/` | `index.cjs` 导出启动模板服务 | 模板持久化和实际启动委托给注入的 store 与 launcher |

## 依赖约定

- 跨领域代码引用对应 `index.cjs`，领域内部引用具体实现。入口显式列出公共能力，不使用批量展开导出。
- 历史会话与 WorkBuddy 入口按属性延迟加载。Token 统计只取转录解析器时不会加载 SQLite 历史查询；额度查询只取用户信息客户端时不会加载签到或模型目录服务。
- 模型桥接只依赖 WorkBuddy 的目录值计算；签到与模型目录共同使用独立 ACP transport，互不依赖业务服务实现。
- WSL 路径转换位于 `electron/core/wsl-paths.cjs`，搜索和远程文件共同引用；纯 SSH 机制继续位于 `electron/ssh/`。
- `terminal-state-hub` 位于 `electron/terminal/`，由主进程创建并注入移动服务。移动服务停止不销毁 hub，应用退出仍由主进程清理。
- 不通过共享可变 context 对象连接组件。移动组件通过显式方法和回调访问活动连接、发布状态和交接尺寸；构造阶段不调用依赖于后续装配的回调。
- 本次保留 `core/ipc-handlers.cjs` 中的中央注册位置。已有 git、idea、remote-files、settings、token-usage 等模块维持自己的注册和生命周期边界。
- 中央终端尺寸 IPC 显式接收主进程注入的移动服务，避免访问未定义变量；忽略会话关闭后迟到的尺寸事件，活动会话仍经过尺寸所有权组件。

## 运行与资源定位

历史查询 Python 脚本与远程读取业务位于同一领域目录，由服务基于 `__dirname` 定位。Electron 打包的 `electron/**/*` 包含迁移后的文件；Codex 桥接 preload 的解包路径不变。用户配置、凭据和数据库路径未迁移。

测试就近放置，使用模拟 transport、文件系统夹具和模拟时钟验证拆分边界。移动服务允许注入 HTTP/WebSocket 工厂与发现服务，便于测试完整装配而无需监听真实网卡。验证使用 `pnpm test`、`pnpm build` 和 `node --check`；真实 SSH、WSL、移动设备及 provider 验收另行记录。
