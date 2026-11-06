// 风险策略层：把「动作 + 目标 + 规模」翻译成 L0–L3，并守住硬红线。
// 这里是护栏的唯一来源：工具实现只调用它，不自己判断。
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, normalize, sep } from 'node:path';
import { dshHome } from './paths.mjs';

export const LEVELS = {
  L0: { id: 'L0', label: '只读', en: 'read-only' },
  L1: { id: 'L1', label: '可逆', en: 'reversible' },
  L2: { id: 'L2', label: '有副作用', en: 'side effects' },
  L3: { id: 'L3', label: '不可逆 / 高危', en: 'irreversible / high risk' },
};

export function levelOf(id) {
  return LEVELS[id] ?? LEVELS.L2;
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 一次性凭证：绑定动作类型 + 目标指纹 + 参数，用于检测「所见非所执行」。 */
export function digestOf({ tool, action, targets, params }) {
  const normalizedTargets = Array.isArray(targets)
    ? targets.map((t) => String(t)).slice().sort()
    : [];
  return sha256(JSON.stringify({ tool, action, targets: normalizedTargets, params: params ?? null }));
}

// ---------------------------------------------------------------- 脱敏
const USER_NAME = (() => {
  try { return process.env.USERNAME || ''; } catch { return ''; }
})();

const TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[a-f0-9]{40,}\b/gi,
];

/** 审计日志只留「哪里发生了什么」，不留可复用的凭据与用户名。 */
export function mask(text) {
  if (text === undefined || text === null) return '';
  let out = String(text);
  try {
    const home = homedir();
    if (home) out = out.split(home).join('<home>');
  } catch { /* 忽略 */ }
  if (USER_NAME) {
    out = out.split(`\\${USER_NAME}\\`).join('\\<user>\\');
    out = out.split(`/${USER_NAME}/`).join('/<user>/');
  }
  out = out.replace(/C:\\Users\\[^\\\s"']+/gi, 'C:\\Users\\<user>');
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, '<redacted>');
  return out;
}

// ---------------------------------------------------------------- 路径与红线
function canon(p) {
  try {
    let v = normalize(String(p));
    if (v.endsWith(sep) && v.length > 3) v = v.slice(0, -1);
    return v.toLowerCase();
  } catch {
    return String(p).toLowerCase();
  }
}

function systemRoot() {
  return canon(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows');
}

function driveRoots() {
  const roots = new Set();
  for (const key of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'PUBLIC', 'USERPROFILE', 'SystemDrive']) {
    const value = process.env[key];
    if (!value) continue;
    const c = canon(value);
    const m = /^([a-z]:)(\\|$)/.exec(c);
    if (m) roots.add(`${m[1]}\\`);
  }
  return roots;
}

/** 任何情况下都不允许改写的目录（即使有确认也不行）。 */
export function redLineReasonForPath(p) {
  const c = canon(p);
  const forbidden = [
    systemRoot(),
    `${systemRoot()}\\system32`,
    `${systemRoot()}\\syswow64`,
    `${systemRoot()}\\winsxs`,
    `${systemRoot()}\\system32\\drivers`,
    canon(process.env.ProgramFiles || 'C:\\Program Files'),
    canon(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'),
    canon(dshHome()),
  ].filter(Boolean);

  for (const root of forbidden) {
    if (c === root) return root;
    if (c.startsWith(`${root}\\`)) return root;
  }
  // 盘符根目录本身（C:\ 这种）不允许直接批量操作
  for (const root of driveRoots()) {
    if (c === root) return root;
    if (c === root.replace(/\\$/, '')) return root;
  }
  if (c === canon(homedir())) return canon(homedir());
  return null;
}

export function isInsideRoots(p, roots) {
  if (!Array.isArray(roots) || roots.length === 0) return true;
  const c = canon(p);
  return roots.some((root) => {
    const r = canon(root);
    return c === r || c.startsWith(`${r}\\`);
  });
}

export function samePath(a, b) {
  return canon(a) === canon(b);
}

// ---------------------------------------------------------------- 危险命名
const DANGER_NAME = /(删除|移除|清空|清除|格式化|卸载|重置|销毁|支付|付款|转账|购买|确认支付|发送|提交|发布|delete|remove|erase|wipe|format|uninstall|reset|destroy|pay\b|payment|purchase|buy now|send|submit|publish|confirm order|checkout)/i;

/** 目标元素的名字像「不可撤销的终点动作」时，把等级抬到 L3。 */
export function looksIrreversible(name) {
  if (!name) return false;
  return DANGER_NAME.test(String(name));
}

const DENIED_KEY_COMBOS = [
  { pattern: /^(WIN|LWIN)\+L$/i, reason: '会锁定当前会话，中断用户操作' },
  { pattern: /^CTRL\+ALT\+DEL(ETE)?$/i, reason: '属于安全桌面操作，程序无法也不能模拟' },
  { pattern: /^(WIN|LWIN)\+R$/i, reason: '打开「运行」对话框，容易变成执行任意命令的后门' },
];

export function deniedKeyCombo(combo) {
  const value = String(combo ?? '').trim();
  for (const rule of DENIED_KEY_COMBOS) {
    if (rule.pattern.test(value)) return rule.reason;
  }
  return null;
}

// ---------------------------------------------------------------- 判定辅助
export function decide({ level, confirmRequired, reason }) {
  return { level, confirmRequired: Boolean(confirmRequired), reason };
}

/** L3 一律要确认；L2 只有命中高危子集才确认。 */
export function needsConfirm(level, highRiskL2 = false) {
  if (level === 'L3') return true;
  if (level === 'L2') return Boolean(highRiskL2);
  return false;
}

export function summarizeTargets(items, limit = 3) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return '（无目标）';
  if (list.length <= limit) return list.join('、');
  return `${list.slice(0, limit).join('、')} 等 ${list.length} 项`;
}

export function homeShorthand(p) {
  try {
    const home = homedir();
    if (p && String(p).toLowerCase().startsWith(home.toLowerCase())) {
      return `%USERPROFILE%${String(p).slice(home.length)}`;
    }
  } catch { /* 忽略 */ }
  return String(p ?? '');
}

export const internalPaths = {
  dshHome,
  pluginData: () => join(dshHome(), 'computer-use'),
};
