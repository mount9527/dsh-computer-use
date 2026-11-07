# 发布到插件市场（awesome-dsh-plugin / dshmarket）

本目录只放**投稿用的材料**，不参与插件运行。

## 两个已确认的外部事实

| 事实 | 影响 |
|---|---|
| npm 上 `dsh-computer-use` **已被他人占用**（`jerryweizhihao` 发布到 0.3.1，另一个 cua-driver 系插件） | 必须换名发布，本项目改用 `@li666/dsh-computer-use` |
| 市场清单 = [`awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的 `data/plugins/*.yml` | 投稿 = 一个 PR、一个 YAML 文件 |

## 为什么不在仓库里直接改包名

本机是 `link:` 方式安装这个 bundle，profile 的 `package.json` 用**依赖键名**注册它：

```json
"dependencies": { "dsh-computer-use": "link:E:/.../dsh-computer-use" },
"dsh": { "profile": { "bundles": ["dsh-computer-use"] } }
```

一旦仓库 manifest 的名字变成 `@mount9527/...`，两边对不上，插件会**整批从工具列表里消失**（实测踩过，`plugin_manager` 报 `unaddressable`）。
所以：**开发目录保持原名，发布时另生成一份改了名的副本。**

## 发布步骤

### 1. 生成发布包

```powershell
cd <本仓库路径>
node scripts/stage-release.mjs
```

它会按 `package.json` 的 `files` 复制文件到 `release/pkg/`（已被 .gitignore 忽略），并：
- 把包名改成 `@li666/dsh-computer-use`
- `cordis.patch.yml` 里只改 `name:`，`id:` 保持不变（带 `@`/`/` 的 id 不合法）

### 2. 发 npm

```powershell
cd release\pkg
npm login                 # 浏览器授权
npm publish --access public
```

scoped 包必须带 `--access public`，否则发成私有包，市场装不上。

### 3. 提市场 PR

fork `awesome-dsh-plugin/awesome-dsh-plugin`，把 [`awesome-dsh-plugin-entry.yml`](awesome-dsh-plugin-entry.yml) 复制成
`data/plugins/mount9527__dsh-computer-use.yml`，**只加这一个文件**，开 PR。

### 4. 给仓库加 topic

GitHub 仓库页 → About 右侧 ⚙ → Topics → 加 `dsh-plugin`。CI 会检查。

## CI 会查什么

| 检查 | 本项目状态 |
|---|---|
| `dsh.bundle` manifest | ✓ 有 |
| 仓库满 1 天 | ⏳ 今天刚建，CI 会自动重跑，不用重提 |
| awesome-lint / README 重生成 | 提交后由 CI 判定 |
| 描述属实（「17 个工具」要真数出来） | ✓ 已核对 |

## 收录后市场里显示什么

- 安装：`dsh plugin --profile web add @li666/dsh-computer-use`
- 详情页截图：来自仓库根目录 `screenshots.json`（`docs/settings.png`、`docs/confirm-dialog.png`）
- 图标：未声明 `icon:`，回退到 owner 头像；要自定义就加一个 **GitHub 托管的位图**（SVG 会被拒）

## 常见被拒原因（本项目已规避）

- 只声明 `dsh.client` 没有 `dsh.bundle` → 有
- 描述夸大 → 只写功能与真实数量
- 纯占位/空壳仓库 → 有真实代码与测试
- 描述带营销词 → 无
