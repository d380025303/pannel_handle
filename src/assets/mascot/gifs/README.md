# 小帕日常 GIF

基于 `../panel-navigator.png`，使用内置 image_gen 生成动作帧，再用 Node 合成。桌面端 `DesktopMascot` 已接入四款 GIF。

桌面展示默认待机，每隔 8–15 秒随机播放一次挥手、工作或庆祝，播放完整一轮后回到待机，避免连续重复相同动作。动画开关关闭、角色收起、页面隐藏或系统启用减少动态效果时停止调度；暂停使用待机第一张 PNG。随机动作独立于会话状态，状态徽标继续反映实际会话状态。

| 文件 | 内容 | 时长 | 播放帧数 |
| --- | --- | --- | --- |
| panna-idle.gif | 呼吸、眨眼 | 3 秒 | 8 |
| panna-wave.gif | 挥手问好 | 2.08 秒 | 14 |
| panna-working.gif | 操作平板、屏幕亮起 | 3 秒 | 14 |
| panna-celebrate.gif | 举手、小跳、开心闭眼 | 2.08 秒 | 14 |

所有 GIF 为 512 × 512、透明背景、无限循环；每款有 8 张不同动作 PNG，部分动画采用往返序列与停顿控制节奏。GIF 仅支持全透明或不透明，PNG 帧保留完整 alpha，适合后续转换成其他格式。

直接用浏览器打开 `preview.html`，可切换深色、浅色和透明棋盘背景，并下载 GIF。

## 保留文件

- `frames/`：统一画布的 PNG 动作帧。
- `sheets/`：内置 image_gen 原始动作图集。
- `prompts.txt`：四款生成提示词。
- `assemble.cjs`：裁帧、统一比例与位置、共用色板及 GIF 编码脚本。
- `validation.json`：GIF 解码检查结果。
- `contact-light.png`、`contact-dark.png`：从最终 GIF 解码得到的代表帧检查图，按待机、问好、工作、庆祝排列。

## 重新合成

在项目以外的工具目录安装依赖，不修改项目 package.json 或锁文件：

```powershell
$toolDir = Join-Path $env:TEMP 'panna-gif-tools'
npm install --prefix $toolDir --no-audit --no-fund sharp@0.35.5 gifenc@1.0.3 omggif@1.0.10
node src/assets/mascot/gifs/assemble.cjs $toolDir
```

## 验证记录

2026-10-09：检查四张原始图集与深浅背景解码代表帧；脚本解码所有 GIF 帧并验证尺寸、透明索引、清除前帧设置、循环次数与时长；Chrome 实际加载播放四款 GIF，检查深浅背景显示与预览按钮。动画采用手绘关键帧风格，包含少量帧间线条变化。

上述素材制作验证未涉及应用代码。后续桌面集成已通过看板娘组件测试与桌面构建，并在 Chrome 独立组件预览中确认随机动作返回待机、尺寸及暂停恢复；实际 Electron 窗口视觉验收尚未完成。完整项目浏览器预览因既有 API mock 的 `onChanged` 缺失而未完成验证。
