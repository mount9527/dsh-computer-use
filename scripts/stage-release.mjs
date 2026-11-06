// 生成发布包：把仓库内容按 `files` 清单复制到 release/pkg，并把包名换成可发布的
// 作用域名（npm 上 `dsh-computer-use` 已被他人占用）。
//
// 为什么不直接在仓库里改名：本机是 `link:` 方式安装的 bundle，profile 的 package.json
// 用**依赖键名**注册它（"dsh-computer-use": "link:..."），一旦仓库里的 manifest 名字变了，
// 解析就对不上，插件会整批从工具列表里消失（实测踩过）。所以开发目录保持原名，
// 发布时在 release/ 里生成一份改了名的副本。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLISH_NAME = '@mount9527/dsh-computer-use';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const outRoot = join(root, 'release');
const outDir = join(outRoot, 'pkg');

// 与 package.json 的 files 字段保持一致（由 files 驱动，避免手工列表漂移）
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function expand(pattern) {
  // 只支持本仓库实际用到的两种形式：精确路径、以及 `dir/*.ext`
  if (!pattern.includes('*')) return [pattern];
  const slash = pattern.lastIndexOf('/');
  const dir = pattern.slice(0, slash);
  const ext = pattern.slice(pattern.lastIndexOf('*') + 1); // 形如 ".mjs"
  const absDir = join(root, dir);
  if (!existsSync(absDir)) return [];
  const { readdirSync } = fsCache;
  return readdirSync(absDir).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);
}

const fsCache = await import('node:fs');

const targets = new Set(['package.json']);
for (const pattern of pkg.files ?? []) {
  for (const rel of expand(pattern)) {
    if (existsSync(join(root, rel))) targets.add(rel);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const rel of targets) {
  const from = join(root, rel);
  if (!existsSync(from)) continue;
  const to = join(outDir, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  copied += 1;
}

// 改名：manifest 与 cordis.patch.yml 必须同时改，否则 `dsh plugin add` 注册的模块名找不到
const outPkgPath = join(outDir, 'package.json');
const outPkg = JSON.parse(readFileSync(outPkgPath, 'utf8'));
const originalName = outPkg.name;
outPkg.name = PUBLISH_NAME;
outPkg.version = pkg.version;
writeFileSync(outPkgPath, `${JSON.stringify(outPkg, null, 2)}\n`, 'utf8');

const patchPath = join(outDir, 'cordis.patch.yml');
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8');
  // 只替换 name: 后面的模块名；id 保持原样（带 @ / 的 id 不是合法标识）
  const rewritten = patch.replace(/(^\s*name:\s*['"]?)([^'"\r\n]+)(['"]?)/gm, (m, a, value, c) => {
    return value === originalName ? `${a}${PUBLISH_NAME}${c}` : m;
  });
  writeFileSync(patchPath, rewritten, 'utf8');
}

// 发布包里不该带的东西：这是给 npm 的，不是给人看的源码树
rmSync(join(outDir, 'release'), { recursive: true, force: true });

console.log(`发布包已生成：${outDir}`);
console.log(`  文件数：${copied}`);
console.log(`  包名：${originalName} → ${PUBLISH_NAME}`);
console.log(`  版本：${outPkg.version}`);
console.log('');
console.log('下一步：');
console.log(`  cd "${outDir}"`);
console.log('  npm login');
console.log('  npm publish --access public');
