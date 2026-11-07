# Third-party notices / 第三方声明

This project is MIT licensed (see [LICENSE](LICENSE)). The following techniques were
learned from other open-source projects and reimplemented here after being verified on
a real Windows machine. No source code was copied.

本项目以 MIT 授权（见 [LICENSE](LICENSE)）。下列做法参考了其他开源项目的公开实现与文档，
并在真机重新验证后才落地，未复制源码。

## Yu-tao-Li/dsh-computer-use-win

<https://github.com/Yu-tao-Li/dsh-computer-use-win> — MIT.
Itself derived from <https://github.com/cgissing/windows-computer-use>.

| 借鉴点 | 落在哪 |
|---|---|
| Chromium 页面树按需预热 | `scripts/desk.ps1` 的 `Start-ChromiumWebContent`，并补充了「现代 Chromium 没有 RenderWidgetHost 子窗口」时的下探式预热 |
| 真实输入后归还指针与前台（用户动过鼠标就不改回去） | `Restore-Borrowed` |
| `verification: sent / observed` 两级语义 | `computer_ui act` / `computer_input` 的返回值 |
| 启动程序不抢前台 | `SW_SHOWNOACTIVATE` + `SWP_NOACTIVATE` |
| 未命名布局窗格不吃深度预算 | `Build-Tree` 的 `fw` 判定 |

## 未采纳

MCP 服务化架构、25 工具集、思考浮窗、工具预设懒加载 —— 与本项目的形态选择不同。

## Esc 立即停止

对方是独立进程 + 键盘钩子监听并直接取消后端调用；本项目用 `GetAsyncKeyState`
轮询（只观察、不吞键）+ 共享停止标记，`desk.ps1` 在长循环里协作式检查，
并额外提供了页面上的停止按钮通道。
