# Changelog

## 0.3.3 (2026-11-06)

第一次使用体验：把"给开发者看的接口"往"给人用的产品"推了一步。

### 新增

- README 顶部新增「30 秒上手」：三句话规矩 + 五类可直接复制的话术，不用记任何工具名。
- 配套技能 `diannao-caokong`（电脑操控使用说明）：装进用户级 skills 目录，在技能选择器里点一下即可查看"该怎么说 / 遇到提示怎么办"。
- 页面首次加载显示 9 秒「已就绪」提示，说明鼠标归属、Esc 停止、危险动作会确认（`sessionStorage` 去重，每会话一次）。
- `computer_status` 结尾从"下一步建议：computer_windows → computer_ui…"（开发口吻）改成给用户看的能力概述与三条规矩。

### 仓库

- 新增 `.gitignore`（排除 `.cache/`、运行时产物、临时探测脚本）。
- 新增 `.github/workflows/ci.yml`：Node 语法检查、PowerShell 5.1 解析 + `desk.ps1` 纯 ASCII 校验、四个单测、`npm pack --dry-run`。
- 元数据指向 `github.com/mount9527/dsh-computer-use`。

## 0.3.2 (2026-11-06)

错误信息全中文化。发布前最后一个"看起来像半成品"的地方。

### 新增

- `lib/messages.mjs`：错误码 / errno / CDP 异常的中文词典，以及 `localizeDeskFailure` / `describeFsError` / `describeBrowserError`。
- `desk.ps1` 改为输出**稳定错误码**（`$script:FailCodes` 表 + `Get-FailCode`），脚本保持纯 ASCII；14 个码在 Node 侧翻成中文，并附「下一步」建议。
- `lib/browser-zh.mjs`：在浏览器模块的导出边界统一翻译——抛出的异常重新抛成中文 Error，返回对象里的 `error` 就地改写。
- `lib/files.mjs`：fs 错误走 errno → 中文映射（ENOENT / EPERM / EBUSY / ENOSPC …）。
- 原始英文保留为「技术细节 / 原始信息」，便于排查。

### 修复

- `result.hints` 是空数组时仍会渲染出空括号 `（）`（三处）。

### 测试

- 新增 `test/messages.mjs`（29 项：每个错误码、fs errno、CDP 异常、中文不重复包装、成功结果不被改写）。
- 实测：`computer_ui mode=act h=0xdeadbeef` 返回中文说明 + 下一步，不再出现 `window handle is invalid or closed`。

## 0.3.1 (2026-11-06)

修掉唯一会导致"两个会话同时抢鼠标"的硬伤。

### 新增

- **桌面互斥**：会改动共享外部状态的调用（`computer_ui mode=act`、`computer_input`、`computer_app`、
  `computer_files` 写操作、`browser_open/act/close`）要拿一把全局租约。
  - 实现是 `desktop.lock` **目录** + `owner.json`（Windows 上建目录是原子的，比"先查再建"可靠）
  - 同一会话续租不自锁；租约 120 秒过期可抢占；启动时清理崩溃残留；损坏/空锁目录按过期处理
  - 冲突时返回【桌面被占用】并明确告诉模型这是结论、不要重试
  - `computer_status`、`/settings/status` 与设置页都会显示当前占用情况
- 系统提示词新增"桌面是独占的"一节。

### 测试

- 新增 `test/session-lock.mjs`（12 项）。
- 真并发实测：子 agent 在另一个会话发起 `computer_files mkdir`，被另一个会话 `computer_app` 的租约当场挡住。

### 修复

- 【桌面被占用】的文案把"租约还剩 N 秒"错写成"N 秒前开始"。

## 0.3.0 (2026-11-06)

两个"立刻能被感知"的能力：工具集预设与桌面侧等待。

### 新增

- **工具集预设 `toolMode`**：`full`（17 个）/ `lite`（核心+桌面+文件）/ `lazy`（只留 3 个入口）。
  在设置页里切换；改预设本身需要重载一次插件。
- **`computer_tools`**：`action=list` 看分组与已加载情况，`action=enable group=<分组>` **现场加载**工具，
  不需要重载插件（`ctx.tools.register` 运行期可用）。分组：core / desktop / files / govern / browser。
- **`computer_wait`**：在一个进程里轮询，等窗口出现（`kind=window`+标题正则）、等控件出现
  （`kind=control`+`h`/`role`/`name`）、等文件出现或消失（`kind=file`+`path`/`gone`）。
  比"反复调 windows/tree"便宜几十倍，且 **Esc 能打断等待**。
- 设置页新增「工具集」下拉；保存时会提示"预设需重载才生效"。
- 系统提示词新增两节：按需加载工具的规矩、等待要用 `computer_wait` 而不是反复观察。

### 变更

- `desk.ps1` 新增 `wait` 动词（`-Verb wait`），返回 `{kind, waitedMs, found}`；超时返回 `timedOut: true` 而不是报错。
- `computer_files op=list` 的渲染现在带修改时间列（0.2.0 已加字段，这版把它显示出来）。

## 0.2.0 (2026-11-06)

发布准备版本：补齐设置界面、发布元数据，并修掉几处只有真用起来才会发现的缺陷。

### 新增

- **设置页**：页面右下角「⚙」打开，或直接访问插件路由 `/settings`。可改总开关、非侵入模式、急停保持时长、确认超时、批量阈值、观察新鲜度、允许根目录、应用白名单、受保护进程、浏览器路径/无头、各类保留期。保存即时生效，无需重启。
  - 带校验与裁剪（超出范围会裁剪并提示），红线项不会被设置页关掉。
  - 同页显示运行状态：总闸、模式、急停状态、Esc 监听心跳、上次 Esc。
- **网页控件**：右下角除「停止」外新增「⚙」设置入口；停止按钮状态与 Esc 通道一致。
- `computer_files op=list` 现在返回**修改时间与大小**（此前只有大小，归档/整理类任务被迫另调 shell 读 mtime）。
- `LICENSE`（MIT，含第三方致谢）、`README.en.md`、`CHANGELOG.md`。
- `package.json` 补齐 `repository` / `homepage` / `bugs` / `author` / `os` / `keywords`，`files` 覆盖新增文件。

### 修复

- **急停规则**：任何 Esc 都按 `stopHoldMs`（默认 60 秒）保持。此前"空闲时按 Esc"只保持 10 秒，而实测从按键到下一次工具调用要 10–30 秒，导致用户按了却看不到反应。
- **Esc 监听进程**：新增心跳文件与异常日志；每次工具调用检查存活并自动重启（此前它可能悄悄退出且无痕迹）。
- **长操作期间不再"卸甲"**：`desk.ps1` 在长循环里持续刷新活动戳，整个操作期间 Esc 都能生效。
- **状态文案**：如实显示「上次 Esc N 秒前（当时正在做事/空闲）」，不再出现"还没收到过 Esc"的误导。
- **webServer 路由重复**：prefix 路由重复注册会让整个插件激活失败，改为每次激活使用独立随机前缀，且注册失败不连累工具与 Esc 通道。

### 变更

- `computer_ui` 的 `depth` 上限 12 → 16（现代 Chromium 的网页根节点在第 11 层左右）。
- 启动程序改为 `SW_SHOWNOACTIVATE` + `SWP_NOACTIVATE`：窗口可见置顶，但**不抢前台**。

## 0.1.0

首个可用版本：9 个桌面工具、L3 原生模态确认、审计与撤销、非侵入模式（UIA 模式 + 窗口消息）、指针/前台归还、Chromium 页面树按需预热、6 个 CDP 浏览器工具。
