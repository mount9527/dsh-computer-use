# 发布到插件市场（awesome-dsh-plugin / dshmarket）

本目录只放**投稿用的材料**，不参与插件运行。

## 现状

| 项 | 状态 |
|---|---|
| 仓库 | https://github.com/mount9527/dsh-computer-use（公开，含 `dsh.bundle` + `cordis.patch.yml`） |
| npm 包名 | `dsh-computer-use` **已被他人占用**（`jerryweizhihao`，另一个 cua-driver 插件），故改用 `@mount9527/dsh-computer-use` |
| 市场收录 | 未提交 |
| 仓库 age 门槛 | 需满 1 天；CI 会自动重跑，不用重提 |

## 一次投递要做的事

1. **给仓库加 topic `dsh-plugin`**（GitHub 仓库页 → About 右侧 ⚙ → Topics）。CI 会检查。
2. **发 npm 包**（可选，但推荐——市场能显示下载量）：
   ```powershell
   cd E:\ruanjianxiazai\deepseek\work\dsh-computer-use
   npm login              # 浏览器授权
   npm publish --access public
   ```
   包名是 `@mount9527/dsh-computer-use`，scoped 包必须带 `--access public`。
3. **提 PR**：fork `awesome-dsh-plugin/awesome-dsh-plugin`，把
   [`awesome-dsh-plugin-entry.yml`](awesome-dsh-plugin-entry.yml) 复制成
   `data/plugins/mount9527__dsh-computer-use.yml`，只加这一个文件，然后开 PR。
   - 文件名格式固定：`<owner>__<repo>.yml`
   - 只改自己那一条；README 是生成的，别手改
4. 等 CI：`dsh.bundle` / 仓库年龄 / awesome-lint / README 重生成。

## 收录后市场里显示什么

- 安装命令：`dsh plugin --profile web add @mount9527/dsh-computer-use`
- 详情页截图：来自本仓库根目录的 `screenshots.json`（当前声明 `docs/settings.png`、`docs/confirm-dialog.png`）
- 图标：未声明 `icon:`，会回退到 owner 头像；要自定义就在 `data/plugins/...yml` 里加一个 **GitHub 托管的位图**（SVG 会被拒）

## 被拒的常见原因（本项目已规避）

- 只声明 `dsh.client` 而没有 `dsh.bundle` → 已声明
- 描述夸大（写「17 个工具」就得真有 17 个）→ 数量已核对
- 纯占位/空壳仓库 → 有真实代码与测试
- 描述带营销词 → 只写功能
