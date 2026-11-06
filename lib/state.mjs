// 插件自己的运行期配置与状态。
// 刻意不声明 schemastery Config：本地目录安装是符号链接，插件目录解析不到 asar 内的
// @deepseek-ai/* 包，声明 Config 会让插件在装配阶段直接失败。
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dataDir, stateFile } from './paths.mjs';

const DEFAULT_ALLOWED_APPS = [
  'notepad.exe', 'explorer.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe',
  'control.exe', 'mspaint.exe', 'calc.exe', 'msedge.exe', 'chrome.exe',
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'wps.exe', 'et.exe', 'wpp.exe',
  'code.exe', 'wt.exe', 'taskmgr.exe', 'snippingtool.exe',
];

const PROTECTED_PROCESSES = [
  'winlogon.exe', 'csrss.exe', 'services.exe', 'lsass.exe', 'smss.exe',
  'dwm.exe', 'svchost.exe', 'explorer.exe', 'system', 'registry',
];

export function defaultState() {
  return {
    version: 1,
    // 急停（Esc / 页面停止按钮）保持多久：这段时间内所有会改动电脑的动作都被拒绝。
    // 急停是"这一阵停住"，不是永久冻结；要长期冻结用 paused。
    stopHoldMs: 60000,
    // 说明：实测从用户按下 Esc 到 agent 下一次工具调用要 10–30 秒，所以不设更短的窗口，
    // 任何 Esc 都按 stopHoldMs 保持。
    // 工具预设：full=全部 19 个；lite=桌面常用（不含浏览器/审计/真键鼠）；lazy=只留 3 个入口
    // 改这个需要重载插件才生效（工具是在 apply 时注册的）
    toolMode: 'full',
    // 总闸：暂停后除只读工具外全部拒绝
    paused: false,
    // 非侵入模式（默认开）：不移动物理光标、不抢焦点，只用 UI 自动化模式与窗口消息操作。
    // 要模拟真鼠标/真键盘必须显式传 allowIntrusive 并由用户点确认窗。
    nonIntrusive: true,
    // L3 / 高危 L2 的原生模态确认
    // 浏览器自动化（CDP）
    browser: {
      // 留空 = 自动找 Edge / Chrome
      exePath: '',
      // 无头模式默认开：完全不打扰用户（不弹窗、不抢焦点）。需要人工登录时临时传 visible=true
      headless: true,
    },
    confirmEnabled: true,
    confirmTimeoutMs: 30000,
    // 允许操作的应用（launch 白名单）；不在名单里的启动要过模态确认
    allowedApps: DEFAULT_ALLOWED_APPS.slice(),
    protectedProcesses: PROTECTED_PROCESSES.slice(),
    // 文件操作的作用范围：不在这些根下的写入/删除一律 L3
    allowRoots: [],
    // 观测新鲜度：没有及时观察就拒绝盲点坐标
    observationTtlMs: 120000,
    // 批量阈值：>= 该数量的覆盖/删除升级为模态确认
    bulkThreshold: 10,
    // 审计与截图保留
    logRetentionDays: 30,
    shotRetentionDays: 7,
    trashRetentionDays: 7,
    // 单次批量操作的硬上限
    maxBatch: 500,
    updatedAt: new Date().toISOString(),
  };
}

let cached = null;
let cachedStamp = -1;

/** 文件指纹：用户手工改了 state.json（或别的进程写了它），下一次读取就应该看到新值。 */
function stamp() {
  try {
    const st = statSync(stateFile());
    return st.mtimeMs + st.size;
  } catch {
    return 0;
  }
}

export function loadState() {
  const current = stamp();
  if (cached && current === cachedStamp) return cached;
  try {
    const raw = JSON.parse(readFileSync(stateFile(), 'utf8'));
    cached = { ...defaultState(), ...raw };
    if (!Array.isArray(cached.allowedApps)) cached.allowedApps = DEFAULT_ALLOWED_APPS.slice();
    if (!Array.isArray(cached.protectedProcesses)) cached.protectedProcesses = PROTECTED_PROCESSES.slice();
    if (!Array.isArray(cached.allowRoots)) cached.allowRoots = [];
    // 红线不可被配置文件关掉：确认通道必须存在
    if (cached.confirmEnabled === false) cached.confirmEnabled = true;
  } catch {
    cached = defaultState();
  }
  cachedStamp = current;
  return cached;
}

export function saveState(patch) {
  const next = { ...loadState(), ...patch, updatedAt: new Date().toISOString() };
  cached = next;
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify(next, null, 2), 'utf8');
  } catch {
    // 状态写失败不影响已生效的内存值
  }
  cachedStamp = stamp();
  return next;
}
