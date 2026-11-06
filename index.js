// dsh-computer-use · 宿主半边
// 把「自然语言任务」翻译成「对这台 Windows 电脑的可验证操作序列」：
// 观察（结构化优先）→ 计划 → 单步执行 → 验证 → 留痕，L3 动作走原生模态确认。
//
// 设计约束（实测得来）：
//  - 只依赖 Node 内置 + 本包内模块：本地目录安装是符号链接，插件目录解析不到 asar 内的
//    @deepseek-ai/* 包，所以不声明 schemastery Config，配置走自己的 state.json。
//  - 真正的桌面动作由 scripts/desk.ps1 子进程完成，子进程从宿主进程派生（正常完整性
//    级别），因此可以注入鼠标键盘、弹原生模态；pwsh 工具跑在低完整性沙箱里做不到这些。
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { desk, runVerb } from './lib/desk.mjs';
import {
  closeBrowser, click as browserClick, describeElement, ensureSession, goBack as browserGoBack,
  navigate as browserNavigate, pressKey as browserPressKey, readElements, readText as browserReadText,
  reload as browserReload, screenshot as browserScreenshot, scrollPage, sessionInfo,
  setChecked as browserSetChecked, selectOption as browserSelectOption, typeInto as browserTypeInto,
  waitFor as browserWaitFor,
} from './lib/browser-zh.mjs';
import { appendAudit, listManifests, readRecent, shotPath } from './lib/audit.mjs';
import { executePlan, planOperation, undoRun } from './lib/files.mjs';
import {
  deniedKeyCombo, digestOf, homeShorthand, levelOf, looksIrreversible, needsConfirm,
} from './lib/policy.mjs';
import { clearStop, markActivity, readStop, requestStop, startWatcher, stopFile, stopWatcher, watcherInfo } from './lib/stop.mjs';
import { loadState, saveState } from './lib/state.mjs';
import { acquireLease, clearStaleLock, lockInfo, releaseLease } from './lib/session-lock.mjs';
import { renderSettingsHtml, sanitizePatch } from './lib/settings-page.mjs';
import { describeFsError } from './lib/messages.mjs';
import { dataDir, logsDir, shotsDir, trashDir } from './lib/paths.mjs';

export const name = 'dsh-computer-use';
export const inject = ['tools', 'systemPrompt'];

const VERSION = '0.4.0';

// ---------------------------------------------------------------- 进程内护栏
/** 同一时刻只允许一个模态确认：弹窗期间禁止其他动作（避免「遮罩期间还在动」）。 */
let confirmBusy = false;
/** 最近的观测（截图 / UI 树），用于「没观察过就不许盲点坐标」。 */
const observations = [];

function recordObservation(entry) {
  observations.push({ at: Date.now(), ...entry });
  if (observations.length > 24) observations.shift();
}

function coverageFor(x, y) {
  const ttl = loadState().observationTtlMs ?? 120000;
  const now = Date.now();
  for (let i = observations.length - 1; i >= 0; i -= 1) {
    const o = observations[i];
    if (now - o.at > ttl) continue;
    if (!o.rect) continue;
    if (x >= o.rect.x && y >= o.rect.y && x <= o.rect.x + o.rect.w && y <= o.rect.y + o.rect.h) return o;
  }
  return null;
}

function deny(message) {
  throw new Error(message);
}

/**
 * 哪些调用算「改动共享外部状态」，需要拿桌面租约。
 * 只读观察（status/windows/screenshot/ui tree|find/wait/audit/browser read）不拿锁：
 * 两个会话同时看屏幕不会打架，而且拒掉它们只会让人莫名其妙。
 */
function isSharedMutation(toolName, args) {
  switch (toolName) {
    case 'computer_ui': {
      const mode = String(args?.mode ?? '');
      return mode === 'act';
    }
    case 'computer_input':
    case 'computer_app':
      return true;
    case 'computer_files':
      return String(args?.op ?? '') !== 'list';
    case 'browser_open':
    case 'browser_close':
    case 'browser_act':
      return true;
    default:
      return false;
  }
}

// 非侵入模式下的说明：电脑在干活，但鼠标还归你。
const INTRUSIVE_HINT = [
  '非侵入模式（默认）：不移动物理光标、不抢键盘焦点，只用 UI 自动化模式 + 窗口消息操作控件。',
  '要模拟真鼠标 / 真键盘，请显式传 allowIntrusive=true —— 会先弹原生确认窗，你点「执行」才会接管。',
].join('\n');

/** 网页上注入的右下角控件：停止按钮（与 Esc 同通道）+ 设置入口。 */
function injectStopButton(html, prefix) {
  const block = `
<style id="dsh-cu-stop-style">
#dsh-cu-dock{position:fixed;right:14px;bottom:92px;z-index:2147483000;display:flex;align-items:center;gap:8px}
#dsh-cu-stop{display:flex;align-items:center;gap:7px;padding:7px 12px;border-radius:999px;
border:1px solid rgba(127,127,127,.35);background:rgba(24,26,32,.82);color:#f2f4f8;
font:12px/1.2 "Microsoft YaHei UI","Segoe UI",sans-serif;cursor:pointer;opacity:.72;
box-shadow:0 2px 10px rgba(0,0,0,.28);user-select:none}
#dsh-cu-stop:hover{opacity:1}
#dsh-cu-stop.stopped{background:rgba(178,38,38,.94);border-color:rgba(255,130,130,.55);opacity:1}
#dsh-cu-stop .cu-dot{width:8px;height:8px;border-radius:50%;background:#ff6b6b;flex:none}
#dsh-cu-stop.stopped .cu-dot{background:#fff}
#dsh-cu-gear{width:30px;height:30px;border-radius:50%;border:1px solid rgba(127,127,127,.35);
background:rgba(24,26,32,.82);color:#eef1f7;font-size:14px;line-height:1;cursor:pointer;opacity:.6}
#dsh-cu-gear:hover{opacity:1}
#dsh-cu-frame{position:fixed;inset:0;z-index:2147482999;width:100%;height:100%;border:0;
background:#f6f7f9;display:none}
#dsh-cu-frame.open{display:block}
#dsh-cu-ready{position:fixed;left:50%;transform:translateX(-50%);bottom:26px;z-index:2147483001;
max-width:min(680px,86vw);padding:9px 16px;border-radius:10px;background:rgba(20,108,60,.94);color:#fff;
font:12.5px/1.5 "Microsoft YaHei UI","Segoe UI",sans-serif;box-shadow:0 6px 22px rgba(0,0,0,.3);
opacity:0;transition:opacity .35s ease;pointer-events:none}
#dsh-cu-ready.show{opacity:1}
</style>
<div id="dsh-cu-ready"></div>
<div id="dsh-cu-dock">
  <button id="dsh-cu-stop" type="button" title="停止 dsh-computer-use 正在做的操作（等同按 Esc）">
    <span class="cu-dot"></span><span id="dsh-cu-stop-label">停止</span>
  </button>
  <button id="dsh-cu-gear" type="button" title="电脑操控设置">⚙</button>
</div>
<iframe id="dsh-cu-frame" title="dsh-computer-use 设置"></iframe>
<script>
(function(){
  var base = '${prefix}';
  var el = null, label = null, gear = null, frame = null, timer = null;
  function paint(s){
    if(!el || !s) return;
    if(s.stopped){ el.classList.add('stopped'); label.textContent = '已停止 · 继续'; }
    else { el.classList.remove('stopped'); label.textContent = '停止'; }
  }
  function poll(){
    fetch(base + '/status', { cache: 'no-store' })
      .then(function(r){ return r.json(); }).then(paint).catch(function(){});
  }
  function boot(){
    el = document.getElementById('dsh-cu-stop');
    gear = document.getElementById('dsh-cu-gear');
    frame = document.getElementById('dsh-cu-frame');
    if(!el || !gear || !frame){ setTimeout(boot, 400); return; }
    label = document.getElementById('dsh-cu-stop-label');
    el.addEventListener('click', function(){
      var wasStopped = el.classList.contains('stopped');
      fetch(base + (wasStopped ? '/resume' : '/stop'), { method: 'POST' })
        .then(function(r){ return r.json(); })
        .then(function(s){ paint(s); if(!wasStopped){ setTimeout(poll, 1500); } })
        .catch(function(){});
    });
    gear.addEventListener('click', function(){
      var open = frame.classList.contains('open');
      if(open){ frame.classList.remove('open'); frame.src = 'about:blank'; }
      else { frame.src = base + '/settings'; frame.classList.add('open'); }
    });
    poll();
    if(timer) clearInterval(timer);
    timer = setInterval(poll, 2500);

    // 装好/重载后的第一次加载，给一个"已就绪"的提示，然后自己消失。
    // 只在对用户第一次说话有用：告诉他鼠标归自己、Esc 能停、危险动作会确认。
    try {
      if(!sessionStorage.getItem('dsh-cu-ready-shown')){
        var ready = document.getElementById('dsh-cu-ready');
        if(ready){
          ready.textContent = '电脑操控已就绪：鼠标始终归你，按 Esc 或点右下角「停止」可随时打断；删除/关窗口/发送一类会先弹确认窗才动。';
          ready.classList.add('show');
          sessionStorage.setItem('dsh-cu-ready-shown', '1');
          setTimeout(function(){ ready.classList.remove('show'); }, 9000);
        }
      }
    } catch(e) { /* 隐私模式下 sessionStorage 可能不可用 */ }
  }
  if(document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', boot); } else { boot(); }
})();
</script>`;
  return html.includes('</body>') ? html.replace('</body>', `${block}\n</body>`) : `${html}${block}`;
}

function requireActive(tool, readOnly = false) {
  const state = loadState();
  // 记录活动：Esc 监听只在插件刚做过事的时候生效，避免别人随手按 Esc 打断
  markActivity();
  // 监听进程死掉过一次，所以每次工具调用都顺手自愈
  startWatcher();

  // 急停优先于一切：Esc 或页面停止按钮写的标记，这里和 desk.ps1 都会读
  const stopped = readStop(state);
  if (stopped && !readOnly) {
    deny([
      `【已停止】用户按下了停止（来源：${stopped.source}${stopped.armed ? '' : '，空闲时按下'}），${Math.ceil(stopped.remainingMs / 1000)} 秒内所有会改动电脑的动作都会被拒绝。`,
      '不要重试、不要换路径绕行、不要把它当故障。把任务当作被用户中断：说明停在了哪一步、已经改了什么、怎么撤回去，然后等用户新的指令。',
      '要立刻恢复，可以点页面上的「继续」，或等这次停止到期。',
    ].join('\n'));
  }

  if (!state.paused) return;
  if (readOnly) return;
  if (tool === 'computer_status' || tool === 'computer_audit' || tool === 'computer_pause') return;
  deny('已被用户暂停（kill switch 生效中）：只读观察仍可用，但任何会改动电脑的动作都被拒绝。恢复需要用户点「computer_pause action=resume」弹出的确认窗。');
}

// ---------------------------------------------------------------- 输出格式
function line(...parts) {
  return parts.filter((p) => p !== undefined && p !== null && p !== '').join(' ');
}

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function renderOcr(ocr, maxLines = 60) {
  if (!ocr) return [];
  if (ocr.error) return [`OCR 不可用：${ocr.error}`];
  const lines = Array.isArray(ocr.lines) ? ocr.lines : [];
  if (lines.length === 0) return ['OCR：这张图上没有识别到文字'];
  const out = [`OCR（${ocr.lang}，${lines.length} 行，坐标即屏幕像素）：`];
  for (const item of lines.slice(0, maxLines)) {
    out.push(`  ${String(item.x).padStart(5)} ${String(item.y).padStart(5)}  ${item.w}x${item.h}  ${item.text}`);
  }
  if (lines.length > maxLines) out.push(`  … 另有 ${lines.length - maxLines} 行未显示`);
  return out;
}

function renderTree(node, depth = 0, maxDepth = 6, out = []) {
  if (!node || depth > maxDepth || out.length > 400) return out;
  const bounds = node.b ? `${node.b.x},${node.b.y} ${node.b.w}x${node.b.h}` : '-';
  const flags = [];
  if (node.e === false) flags.push('disabled');
  if (node.o) flags.push('offscreen');
  if (node.pw) flags.push('PASSWORD');
  if (node.f) flags.push('focus');
  const patterns = Array.isArray(node.k) && node.k.length ? ` {${node.k.join(',')}}` : '';
  const value = node.v !== undefined ? ` = "${String(node.v).replace(/\s+/g, ' ').slice(0, 80)}"` : '';
  const label = node.n ? `"${String(node.n).replace(/\s+/g, ' ').slice(0, 90)}"` : '';
  const id = node.id ? ` #${node.id}` : '';
  const nh = node.nh ? ` nh=${node.nh}` : '';
  out.push(`${'  '.repeat(depth)}[${node.p}] ${node.r} ${label}${id}${nh} @${bounds}${patterns}${value}${flags.length ? ` (${flags.join(',')})` : ''}`);
  for (const child of Array.isArray(node.ch) ? node.ch : []) {
    renderTree(child, depth + 1, maxDepth, out);
  }
  return out;
}

// ---------------------------------------------------------------- 确认通道
/**
 * 原生模态确认。返回 { decision, digest, elapsedMs }。
 * 任何异常都按「拒绝」处理（fail closed）：宁可不动，也不能静默执行。
 */
async function askConfirm({ level, actionText, scopeText, impactText, undoText, items, digest, noteText }) {
  const state = loadState();
  if (confirmBusy) {
    return { decision: 'unavailable', reason: '已有确认弹窗在等待用户操作，本次动作已拒绝' };
  }
  const timeoutMs = state.confirmTimeoutMs ?? 30000;
  const preview = Array.isArray(items) ? items.slice(0, 20) : [];
  const spec = {
    level,
    digest,
    timeoutMs,
    action: actionText,
    scope: scopeText,
    impact: impactText,
    undo: undoText,
    itemsPreview: preview,
    itemsTotal: Array.isArray(items) ? items.length : 0,
    labels: {
      windowTitle: '高风险操作确认 — dsh-computer-use',
      header: '⚠  高危操作待确认',
      levelText: `${level} · ${levelOf(level).label}`,
      action: '动作',
      scope: '范围',
      impact: '影响',
      undo: '撤销',
      cancel: '取消',
      view: '查看清单',
      execute: '执行',
      items: noteText || '影响对象',
      timeoutHint: ' 秒内无操作将自动取消（超时 = 拒绝，不会执行）',
      listTitle: '待影响清单',
      moreItems: '另有项目未展开',
    },
  };

  confirmBusy = true;
  let result;
  try {
    result = await desk.confirm(spec, { timeoutMs: timeoutMs + 45000 });
  } finally {
    confirmBusy = false;
  }

  if (!result.ok) {
    return { decision: 'unavailable', reason: result.error || '确认弹窗不可用' };
  }
  const choice = result.data?.choice;
  if (result.data?.digest !== undefined && result.data.digest !== digest) {
    return { decision: 'drift', reason: '弹窗回执与当前动作不一致，已作废' };
  }
  if (choice === 'execute') return { decision: 'execute', digest, elapsedMs: result.data?.elapsedMs };
  if (choice === 'timeout_denied') return { decision: 'timeout_denied', reason: '超时未响应，视为拒绝' };
  if (choice === 'unavailable') return { decision: 'unavailable', reason: result.data?.reason || '没有可交互的桌面' };
  return { decision: 'cancel', reason: '用户取消' };
}

function confirmDenialMessage(tool, decision, reason) {
  return [
    `【已拒绝，未执行】${tool}：${reason || decision}`,
    '取消后的规则：停下，不重试，不换路径绕行，不降级成别的动作去达成同一目标。',
    '把原任务、被拒绝的步骤、以及可选替代方案（各自风险）一起报告给用户，等用户重新指令。',
  ].join('\n');
}

// ---------------------------------------------------------------- 应用
export function apply(ctx, config) {
  const disposers = [];
  let providerDispose = null;
  let providerError = null;

  // 1) 认领共享的 computer-use provider 槽位（若宿主提供该服务）。
  //    槽位是唯一的：已被别的 provider 占用时只记状态，不影响本插件自己的工具。
  const computerUse = typeof ctx.get === 'function' ? ctx.get('computerUse') : undefined;
  if (computerUse && typeof computerUse.register === 'function') {
    Promise.resolve(computerUse.register('dsh-computer-use'))
      .then((dispose) => { providerDispose = dispose; })
      .catch((err) => { providerError = err && err.message ? err.message : String(err); });
  }

  // 1b) 同样认领共享的 browser-use 槽位（若宿主提供该服务）
  const browserUse = typeof ctx.get === 'function' ? ctx.get('browserUse') : undefined;
  let browserProviderDispose = null;
  if (browserUse && typeof browserUse.register === 'function') {
    Promise.resolve(browserUse.register('dsh-computer-use-cdp'))
      .then((dispose) => { browserProviderDispose = dispose; })
      .catch(() => { /* 槽位被占时不影响本插件自己的工具 */ });
  }

  // 1c) 急停：常驻 Esc 监听（只观察不吞按键）+ 网页上的停止按钮，两条通道写同一个标记
  startWatcher();
  // 上次进程崩溃可能留下桌面锁，启动时清一次（只清过期或没有持有人的）
  try { clearStaleLock(); } catch { /* 忽略 */ }
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  // 每次激活用独立前缀：上一次实例若没卸干净，也不会让这次激活失败
  const stopPrefix = `/dsh-cu-${Math.random().toString(36).slice(2, 8)}`;
  let stopRouteError = null;
  if (webServer && typeof webServer.register === 'function') {
    const PREFIX = stopPrefix;
    const reply = (res, code, body) => {
      try {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      } catch { /* 忽略断开的连接 */ }
    };
    const replyHtml = (res, code, html) => {
      try {
        res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(html);
      } catch { /* 忽略 */ }
    };
    const readJsonBody = (req) => new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
        if (raw.length > 200000) { reject(new Error('请求体过大')); req.destroy(); }
      });
      req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(new Error('请求体不是合法 JSON')); } });
      req.on('error', reject);
    });
    const stateOf = () => {
      const st = loadState();
      const stopped = readStop(st);
      const esc = watcherInfo();
      return {
        stopped: Boolean(stopped),
        source: stopped ? stopped.source : '',
        armed: stopped ? stopped.armed : false,
        remainingMs: stopped ? stopped.remainingMs : 0,
        paused: Boolean(st.paused),
        escWatcher: esc,
        lock: lockInfo(),
        holdMs: Number(st.stopHoldMs) > 0 ? st.stopHoldMs : 60000,
      };
    };
    const handler = async (req, res) => {
      try {
        const url = new URL(req.url, 'http://local');
        const path = url.pathname.slice(PREFIX.length) || '/';
        if (req.method === 'GET' && path === '/status') return reply(res, 200, stateOf());
        if (req.method === 'GET' && path === '/settings') {
          // ?embed=1：去掉固定的底部操作栏，用于整页截图/iframe 嵌入
          const embed = url.searchParams.get('embed') === '1';
          return replyHtml(res, 200, renderSettingsHtml(loadState(), PREFIX, { embed }));
        }
        if (req.method === 'GET' && path === '/settings/status') {
          const st = loadState();
          return reply(res, 200, { ...stateOf(), nonIntrusive: st.nonIntrusive !== false });
        }
        if (req.method === 'POST' && path === '/settings') {
          const body = await readJsonBody(req);
          const current = loadState();
          const { patch, errors } = sanitizePatch(body, current);
          if (Object.keys(patch).length === 0) {
            return reply(res, 400, { ok: false, error: errors.join('；') || '没有可保存的字段', errors });
          }
          saveState(patch);
          const needsReload = Object.prototype.hasOwnProperty.call(patch, 'toolMode') && patch.toolMode !== current.toolMode;
          appendAudit({
            tool: 'computer_settings', action: 'update', level: 'L1', ok: true,
            summary: `保存设置：${Object.keys(patch).join(', ')}${needsReload ? '（工具集预设需重载）' : ''}`,
          });
          return reply(res, 200, { ok: true, errors, saved: Object.keys(patch), needsReload });
        }
        if (req.method === 'POST' && path === '/stop') {
          requestStop('button');
          appendAudit({ tool: 'computer_stop', action: 'stop', level: 'L1', ok: true, summary: 'stopped from the page button' });
          return reply(res, 200, { ok: true, ...stateOf() });
        }
        if (req.method === 'POST' && path === '/resume') {
          clearStop();
          appendAudit({ tool: 'computer_stop', action: 'resume', level: 'L1', ok: true, summary: 'stop cleared from the page button' });
          return reply(res, 200, { ok: true, ...stateOf() });
        }
        return reply(res, 404, { ok: false, error: 'unknown route' });
      } catch (err) {
        return reply(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    };
    try {
      disposers.push(webServer.register({ kind: 'prefix', path: PREFIX, handler }));
    } catch (err) {
      // 路由注册失败不应连累工具和 Esc 通道：记下来，状态里如实报告
      stopRouteError = err && err.message ? err.message : String(err);
    }
    if (typeof webServer.tapIndex === 'function') {
      try {
        disposers.push(webServer.tapIndex((html) => injectStopButton(html, PREFIX)));
      } catch (err) {
        stopRouteError = stopRouteError || (err && err.message ? err.message : String(err));
      }
    }
  }

  // 2) 系统提示词：安全段落写在能力段落之前（顺序见 lib 说明）。
  const promptService = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
  if (promptService && typeof promptService.section === 'function') {
    let order = 3000;
    try {
      if (typeof promptService.getSectionOrder === 'function') {
        const resolved = promptService.getSectionOrder('TOOL_COMPUTER_USE');
        if (Number.isFinite(resolved)) order = resolved;
      }
    } catch { /* 用默认 3000 */ }
    disposers.push(promptService.section({
      name: 'computer-use',
      order,
      text: OPERATOR_PROMPT,
    }));
  }

  // 3) 工具
  //    预设（lite/lazy）决定一开始注册哪些；没注册的留在 pending 里，
  //    agent 之后可以调 computer_tools 现场把它们加载进来（无需重载插件）。
  const TOOL_GROUPS = {
    core: '基础（状态 / 总闸 / 工具管理）',
    desktop: '桌面（窗口 / 截图 / UI 自动化 / 应用 / 真键鼠）',
    files: '文件（含撤销）',
    govern: '治理（审计）',
    browser: '浏览器（CDP）',
  };
  const PRESETS = {
    full: ['core', 'desktop', 'files', 'govern', 'browser'],
    lite: ['core', 'desktop', 'files'],
    lazy: ['core'],
  };
  const groupOf = (toolName) => {
    if (toolName === 'computer_status' || toolName === 'computer_pause' || toolName === 'computer_tools') return 'core';
    if (toolName.startsWith('browser_')) return 'browser';
    if (toolName === 'computer_files') return 'files';
    if (toolName === 'computer_audit') return 'govern';
    return 'desktop';
  };
  const toolMode = ['full', 'lite', 'lazy'].includes(loadState().toolMode) ? loadState().toolMode : 'full';
  const enabledGroups = new Set(PRESETS[toolMode] ?? PRESETS.full);
  const pendingTools = [];
  const registeredNames = new Set();

  const output = (extra = {}) => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' }, ...extra },
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  });

  const registerDefinition = (definition) => {
    // 桌面互斥：会改动共享外部状态的调用要拿租约，避免两个会话同时抢鼠标/前台。
    // 统一在注册处包一层，就不用逐个工具改写 execute。
    const original = definition.execute;
    if (typeof original === 'function') {
      definition.execute = async function lockedExecute(args, exec) {
        if (!isSharedMutation(definition.name, args)) {
          return original.call(this, args, exec);
        }
        const owner = String(exec?.agent?.id ?? 'unknown-agent');
        const lease = acquireLease({ owner, tool: definition.name });
        if (!lease.ok) {
          const holder = lease.holder ?? {};
          const seconds = Math.ceil((Number(lease.remainingMs) || 0) / 1000);
          const ageSeconds = Math.max(1, Math.round((Number(lease.ageMs) || 0) / 1000));
          deny([
            `【桌面被占用】另一个会话正在操作这台电脑：${holder.tool || '（未知工具）'}（agent ${String(holder.owner || '?').slice(0, 12)}…，已占用 ${ageSeconds} 秒，租约还剩 ${seconds} 秒）。`,
            '原因：同一时刻只能有一个会话控制鼠标、键盘和前台窗口，否则两边都会点错地方。',
            '这是结论，不是故障：不要重试、不要绕过、不要换个工具硬来。要么等它结束（一般几十秒），要么请用户先让那个会话停下，再让我继续。',
          ].join('\n'));
        }
        try {
          return await original.call(this, args, exec);
        } finally {
          releaseLease(lease.token);
        }
      };
    }
    disposers.push(ctx.tools.register(definition));
    registeredNames.add(definition.name);
    return definition.name;
  };

  const register = (definition) => {
    const group = groupOf(definition.name);
    if (!enabledGroups.has(group)) {
      pendingTools.push({ group, definition });
      return;
    }
    registerDefinition(definition);
  };

  /** 现场加载某个分组里还没注册的工具；返回新加进来的工具名。 */
  const enableGroup = (group) => {
    const added = [];
    for (let i = pendingTools.length - 1; i >= 0; i -= 1) {
      const item = pendingTools[i];
      if (item.group !== group) continue;
      try { added.push(registerDefinition(item.definition)); } catch { /* 忽略单个失败 */ }
      pendingTools.splice(i, 1);
    }
    enabledGroups.add(group);
    return added.reverse();
  };

  // -------------------------------------------------------------- 状态
  register({
    name: 'computer_status',
    description: [
      '读这台电脑的当前状态：系统/会话/屏幕/前台窗口、能力自检（能否注入鼠标键盘、UI 自动化、OCR）、',
      '策略（是否暂停、确认超时、批量阈值、allowRoots）、数据目录。只读，不产生任何副作用。',
      '开始任何一次性任务前只需要调用一次。',
    ].join(''),
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: output(),
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute() {
      const state = loadState();
      const probe = await desk.probe({ timeoutMs: 45000 });
      const rows = [];
      if (!probe.ok) {
        rows.push(`环境探测失败：${probe.error || '未知错误'}`);
        if (probe.hints) rows.push(...probe.hints.map((h) => `  · ${h}`));
      } else {
        const d = probe.data;
        rows.push(`系统：${d.os}  ·  PowerShell ${d.psVersion}  ·  会话 ${d.sessionId}  ·  用户 ${d.user}`);
        rows.push(`屏幕：${d.screen.w}x${d.screen.h}（每显示器 DPI 感知，坐标即物理像素）  ·  光标 ${d.cursor.x},${d.cursor.y}`);
        rows.push(`前台：${d.foreground ? `${d.foreground.h} 「${d.foreground.title}」` : '（无）'}`);
        rows.push(`可见窗口：${d.windows} 个`);
        const cap = d.capabilities || {};
        rows.push(`能力：UI 自动化=${cap.uia ? '可用' : '不可用'}  OCR=${cap.ocr ? `可用（${cap.ocrLang}）` : '不可用'}  原生弹窗=${cap.dialog ? '可用' : '不可用'}  鼠标键盘注入=${cap.input ? '可用' : '不可用'}`);
        if (!cap.input) {
          rows.push('⚠ 本进程无法注入鼠标键盘（低完整性/UIPI）。只能用 UI 自动化做结构化操作 + 截图 OCR 读取，坐标点击与键入会失败并被拒绝。');
        }
        if (!cap.ocr) rows.push('⚠ 没有可用的 Windows OCR 语言包：纯文本模型将无法读取屏幕内容，请优先用 computer_ui 的结构化通道。');
      }
      rows.push(`策略：${state.paused ? '⏸ 已暂停（kill switch 生效）' : '▶ 允许执行'}  ·  操作模式：${state.nonIntrusive !== false ? '非侵入（不移动你的鼠标、不抢键盘焦点）' : '可接管键鼠'}  ·  确认超时 ${state.confirmTimeoutMs}ms  ·  批量阈值 ${state.bulkThreshold} 项  ·  allowRoots ${state.allowRoots.length ? state.allowRoots.join(' ; ') : '（未限制，但系统目录仍是硬红线）'}`);
      rows.push(`provider 槽位：${providerDispose ? '已认领（dsh-computer-use）' : providerError ? `认领失败：${providerError}` : '宿主机未提供 computerUse 服务，本插件以独立工具集工作'}`);
      rows.push(`数据目录：${dataDir()}（截图 ${shotsDir()} / 日志 ${logsDir()} / 隔离区 ${trashDir()}）`);
      const esc = watcherInfo();
      const stoppedNow = readStop(state);
      const beat = esc.running && esc.heartbeatAgeMs > 0
        ? `心跳 ${Math.round(esc.heartbeatAgeMs / 1000)}s 前`
        : esc.running ? '心跳未就绪' : '未运行';
      const lastEsc = esc.lastEscAt
        ? `上次 Esc ${Math.round((Date.now() - esc.lastEscAt) / 1000)}s 前${esc.lastEscArmed ? '（当时正在做事）' : '（当时空闲）'}，一次 Esc 保持 60 秒`
        : '还没收到过 Esc';
      rows.push(`急停：Esc 监听${esc.running ? `运行中（pid=${esc.pid}，${beat}）` : '未运行'} · ${lastEsc} · ${stoppedNow ? `⚠ 已停止（来源 ${stoppedNow.source}，还剩 ${Math.ceil(stoppedNow.remainingMs / 1000)} 秒）` : '当前未在停止中'} · 页面按钮：${stopRouteError ? `不可用（${stopRouteError}）` : `${stopPrefix}/stop`}`);
      rows.push(`设置页：${stopRouteError ? `不可用（${stopRouteError}）` : `${stopPrefix}/settings`}（也可以点页面右下角的 ⚙）`);
      const lock = lockInfo();
      rows.push(lock.held
        ? `桌面占用：${lock.tool || '（未知）'} 正在操作（持有 ${Math.round((lock.ageMs || 0) / 1000)} 秒，${lock.stale ? '已过期，可被抢占' : `租约还剩 ${Math.ceil((lock.remainingMs || 0) / 1000)} 秒`}）`
        : '桌面占用：空闲（同一时刻只允许一个会话改动电脑）');
      rows.push(`版本：${VERSION}`);

      const verdict = probe.ok && probe.data?.capabilities?.input
        ? [
          '就绪。用户可以只说需求，例如「把下载夹里的发票按月份归档」「帮我把这个窗口里的确定点一下」「打开这个网址把表填好，别提交」。',
          '鼠标始终归用户；按 Esc 或点页面右下角的「停止」可随时打断；删除/关窗口/发送/提交一类会先弹确认窗，用户不点就不动。',
        ].join('\n')
        : probe.ok
          ? '只能做结构化/只读动作；需要键鼠的步骤先向用户说明受限原因。'
          : '环境探测失败：先解决 desk.ps1 与 PowerShell 可用性，再重试。';
      rows.push(verdict);

      appendAudit({ tool: 'computer_status', level: 'L0', ok: probe.ok, summary: 'probe' });
      return { text: rows.join('\n') };
    },
  });

  // -------------------------------------------------------------- 观察：窗口
  register({
    name: 'computer_windows',
    description: [
      '列出当前可见的顶层窗口（句柄/标题/类名/进程/位置/大小/是否前台），按 Z 序从上到下。只读。',
      '这是所有 GUI 操作的入口：先拿到窗口句柄 h，再用 computer_ui / computer_screenshot 观察它。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: '最多返回多少个窗口，默认 40' },
      },
    },
    output: output(),
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(args) {
      requireActive('computer_windows', true);
      const limit = Number.isFinite(args?.limit) && args.limit > 0 ? Math.floor(args.limit) : 40;
      const result = await desk.windows({ limit }, { timeoutMs: 45000 });
      if (!result.ok) deny(`窗口枚举失败：${result.error || '未知错误'}`);
      const windows = Array.isArray(result.data.windows) ? result.data.windows : [];
      const rows = [`前台窗口：${result.data.foreground || '（无）'}`];
      if (windows.length === 0) rows.push('没有可见的顶层窗口（可能全部最小化）');
      for (const w of windows) {
        const flags = [];
        if (w.foreground) flags.push('前台');
        if (w.iconic) flags.push('最小化');
        rows.push(line(
          w.h,
          `「${String(w.title).slice(0, 80)}」`,
          `${w.w}x${w.hh}@${w.x},${w.y}`,
          w.cls,
          w.pid ? `pid=${w.pid}` : '',
          flags.length ? `[${flags.join(',')}]` : '',
        ));
      }
      if (result.data.truncated) rows.push(`… 另有 ${result.data.truncated} 个窗口未列出`);
      rows.push('提示：坐标是屏幕物理像素；先 computer_ui mode=tree 看元素，再用 computer_ui mode=act 操作。');
      appendAudit({ tool: 'computer_windows', level: 'L0', ok: true, summary: `${windows.length} windows` });
      return { text: rows.join('\n') };
    },
  });

  // -------------------------------------------------------------- 观察：截图 + OCR
  register({
    name: 'computer_screenshot',
    description: [
      '截图并（可选）OCR 出文字与坐标。mode=screen 全屏 / window 指定窗口 / region 指定矩形。只读。',
      '纯文本模型读不到像素时，用 ocr=true 把屏幕变成「带坐标的文字」，这是视觉兜底的主要形式。',
      '截图会落盘到插件数据目录，用于事后审计；只截必要区域，不要无脑整屏刷。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['screen', 'window', 'region'], description: '默认 screen' },
        h: { type: 'string', description: 'mode=window 时的窗口句柄（如 0x1a2b3c）' },
        rect: {
          type: 'object',
          additionalProperties: false,
          properties: {
            x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, hgt: { type: 'number' },
          },
          description: 'mode=region 时的矩形（x,y,w,hgt）',
        },
        ocr: { type: 'boolean', description: '是否 OCR 出文字，默认 true' },
        lang: { type: 'string', description: 'OCR 语言标签，如 zh-Hans-CN / en-US；默认跟随系统' },
        maxLines: { type: 'number', description: '最多返回多少行 OCR 文本，默认 60' },
        activate: { type: 'boolean', description: 'window 模式下先把窗口切到前台再截，默认 false' },
      },
    },
    output: output({ path: { type: 'string' }, h: { type: 'string' } }),
    isConcurrencySafe: () => false,
    timeoutMs: 120000,
    async execute(args) {
      requireActive('computer_screenshot', true);
      const mode = args?.mode === 'window' || args?.mode === 'region' ? args.mode : 'screen';
      const path = shotPath('shot');
      const spec = { mode, path, ocr: args?.ocr !== false, ocrLimit: 400 };
      if (mode === 'window') {
        if (!args?.h) deny('mode=window 需要 h（窗口句柄，先用 computer_windows 拿）');
        spec.h = String(args.h);
        spec.activate = Boolean(args.activate);
      }
      if (mode === 'region') {
        const rect = args?.rect;
        if (!rect || !Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.w) || !Number.isFinite(rect.hgt)) {
          deny('mode=region 需要 rect = {x,y,w,hgt}');
        }
        spec.rect = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.hgt) };
      }
      if (args?.lang) spec.lang = String(args.lang);

      const result = await desk.shot(spec, { timeoutMs: 90000 });
      if (!result.ok) deny(`截图失败：${result.error || '未知错误'}`);
      const d = result.data;
      recordObservation({
        kind: 'shot',
        h: spec.h,
        rect: { x: d.ox ?? 0, y: d.oy ?? 0, w: d.w ?? 0, h: d.h ?? 0 },
      });

      const rows = [
        `已截图（${d.mode}/${d.source}）：${d.w}x${d.h}  ·  ${humanSize(d.bytes)}`,
        `路径：${d.path}`,
      ];
      if (d.ox || d.oy) rows.push(`该图左上角对应屏幕坐标 ${d.ox},${d.oy}`);
      rows.push(...renderOcr(d.ocr, Number.isFinite(args?.maxLines) && args.maxLines > 0 ? Math.floor(args.maxLines) : 60));
      rows.push('下一步：要点击某段文字时，用 OCR 给出的左上角与尺寸估算中心点，然后 computer_input actions=[{type:"click",...}]（记得带 expectH）。');

      appendAudit({
        tool: 'computer_screenshot',
        level: 'L0',
        ok: true,
        summary: `${d.mode} ${d.w}x${d.h}${d.ocr ? ` ocr=${d.ocr.lines?.length ?? 0}` : ''}`,
        evidence: [d.path],
      });
      return {
        text: rows.join('\n'),
        path: String(d.path ?? path),
        ...(spec.h ? { h: String(spec.h) } : {}),
      };
    },
  });

  // -------------------------------------------------------------- 观察/操作：UI 自动化
  register({
    name: 'computer_ui',
    description: [
      'UI 自动化（首选通道）。mode=tree 读窗口的可访问性树；mode=find 按 role/name/automationId 搜元素；',
      'mode=act 对某个元素执行动作（invoke/click/select/expand/collapse/toggle/focus/setValue/type/scrollIntoView/close）。',
      '结构化操作不依赖坐标、不怕分辨率变化，也不会点错窗外的东西，优先级高于坐标点击。',
      '元素路径 p 来自 tree/find 输出；路径失效（界面变了）就重新读树，不要硬猜。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['mode', 'h'],
      properties: {
        mode: { type: 'string', enum: ['tree', 'find', 'act'] },
        h: { type: 'string', description: '窗口句柄（computer_windows 的 h）' },
        path: { type: 'string', description: 'mode=act：元素路径 p（如 "0/3/1"）' },
        action: {
          type: 'string',
          enum: ['invoke', 'click', 'doubleClick', 'rightClick', 'select', 'expand', 'collapse', 'toggle', 'focus', 'setValue', 'type', 'scrollIntoView'],
          description: 'mode=act：动作。默认 invoke（不碰鼠标不抢焦点）。click/doubleClick/rightClick 在非侵入模式下会先试控件自己的 Invoke，再向控件窗口发窗口消息，都不会移动指针',
        },
        allowIntrusive: { type: 'boolean', description: '允许这次动作接管物理鼠标/键盘（默认 false）。选 true 会先弹原生确认窗，由用户决定' },
        text: { type: 'string', description: 'mode=act 且 action=setValue/type 时写入的文本' },
        role: { type: 'string', description: 'mode=find：控件类型正则，如 Button / Edit / MenuItem' },
        name: { type: 'string', description: 'mode=find 的名称正则；mode=act 时也用于判断这个元素是否是不可撤销的终点动作' },
        automationId: { type: 'string', description: 'mode=find：AutomationId 正则' },
        depth: { type: 'number', description: '遍历深度，默认 6' },
        max: { type: 'number', description: 'tree 最多节点数，默认 300' },
        view: { type: 'string', enum: ['auto', 'control', 'raw', 'content'], description: '默认 auto（control 太瘦自动换 raw）' },
        values: { type: 'boolean', description: '是否读取元素文本值，默认 true' },
        settleMs: { type: 'number', description: '动作后等待多少毫秒再验证，默认 220' },
        windowTitle: { type: 'string', description: '窗口标题（仅用于确认弹窗里给人看，越准确越好）' },
        intent: { type: 'string', description: '这次动作要达成什么（写进确认弹窗；含「删除/发送/支付」等词会升级为 L3）' },
        impact: { type: 'string', description: '对界面后果的说明（写进确认弹窗给人看）' },
        undo: { type: 'string', description: '这一动作怎么撤销（写进确认弹窗给人看）' },
      },
    },
    output: output({ h: { type: 'string' }, fingerprint: { type: 'string' } }),
    isConcurrencySafe: () => false,
    timeoutMs: 150000,
    async execute(args) {
      const mode = args?.mode;
      if (!['tree', 'find', 'act'].includes(mode)) deny('mode 必须是 tree / find / act');
      requireActive('computer_ui', mode === 'tree' || mode === 'find');
      const handle = String(args?.h ?? '').trim();
      if (!handle) deny('需要 h（窗口句柄，先用 computer_windows 拿）');

      const spec = { mode, h: handle };
      if (Number.isFinite(args?.depth)) spec.depth = Math.max(1, Math.min(16, Math.floor(args.depth)));
      if (Number.isFinite(args?.max)) spec.max = Math.max(20, Math.min(2000, Math.floor(args.max)));
      if (args?.view) spec.view = String(args.view);
      if (args?.values !== undefined) spec.values = Boolean(args.values);

      if (mode === 'tree' || mode === 'find') {
        if (mode === 'find') {
          if (args?.role) spec.role = String(args.role);
          if (args?.name) spec.name = String(args.name);
          if (args?.automationId) spec.automationId = String(args.automationId);
          if (!spec.role && !spec.name && !spec.automationId) deny('mode=find 至少给 role / name / automationId 之一');
        }
        const result = await desk.uia(spec, { timeoutMs: 90000 });
        if (!result.ok) deny(`读取 UI 树失败：${result.error || '未知错误'}`);
        const d = result.data;
        const wc = d.webContent;
        const rows = [`窗口 ${d.h} 「${String(d.title).slice(0, 80)}」 · 视图 ${d.view} · ${mode === 'tree' ? `${d.nodes} 个节点` : `${d.count} 个匹配`}${d.truncated ? '（已截断）' : ''}`];
        if (wc && wc.state !== 'none') {
          const stateText = wc.state === 'ready' ? '已就绪' : wc.state === 'starting' ? '仍在生成，稍后重读一次' : wc.state;
          rows.push(`网页内容（Chromium 预热）：${wc.renderers} 个渲染器 · 通道 ${wc.via || '?'} · ${stateText} · 等待 ${wc.waitedMs}ms`);
        }
        if (mode === 'tree') {
          rows.push(...renderTree(d.tree));
          if (d.truncated) rows.push('节点已达上限：用 mode=find 精确定位，或对子元素单独读树。');
          const rect = d.tree?.b;
          if (rect && rect.w > 0) {
            recordObservation({ kind: 'uia-tree', h: d.h, rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h } });
          }
        } else {
          const matches = Array.isArray(d.matches) ? d.matches : [];
          if (matches.length === 0) rows.push('没有匹配元素：放宽条件（role 用 Button|Edit 这类正则），或先看 tree。');
          for (const node of matches) {
            rows.push(...renderTree(node));
          }
          rows.push(`指纹：${d.fingerprint || '（空）'}`);
        }
        rows.push('下一步：mode=act + path 操作某个元素；副作用动作会按风险等级自动决定是否需要用户确认。');
        appendAudit({ tool: 'computer_ui', action: mode, level: 'L0', ok: true, summary: `${mode} ${d.nodes ?? d.count} nodes`, targets: [handle] });
        return {
          text: rows.join('\n'),
          h: String(d.h ?? handle),
          ...(d.fingerprint ? { fingerprint: String(d.fingerprint) } : {}),
        };
      }

      // ---------- act ----------
      const path = String(args?.path ?? '').trim();
      if (!path) deny('mode=act 需要 path（tree/find 的 p 字段）');
      const action = args?.action || 'invoke';
      const allowIntrusive = Boolean(args?.allowIntrusive);
      spec.path = path;
      spec.action = action;
      spec.intrusive = allowIntrusive;
      if (args?.text !== undefined) spec.text = String(args.text);
      if (Number.isFinite(args?.settleMs)) spec.settleMs = Math.max(0, Math.min(10000, Math.floor(args.settleMs)));

      // 风险分级：读 / 文字输入 / 触发类动作分开算；接管键鼠一律 L3
      const textActions = new Set(['setValue', 'type']);
      let level = action === 'focus' || action === 'scrollIntoView' ? 'L1' : textActions.has(action) ? 'L2' : 'L1';
      const irreversibleHint = looksIrreversible(args?.intent || '') || looksIrreversible(args?.name || '');
      if (irreversibleHint && !['focus', 'scrollIntoView'].includes(action)) level = 'L3';
      if (allowIntrusive) level = 'L3';

      let confirmMeta = null;
      if (allowIntrusive || needsConfirm(level) || (level === 'L2' && irreversibleHint)) {
        const digest = digestOf({
          tool: 'computer_ui', action, targets: [handle, path],
          params: { text: spec.text ?? null, settleMs: spec.settleMs ?? null, intrusive: allowIntrusive },
        });
        confirmMeta = await askConfirm({
          level,
          actionText: allowIntrusive
            ? `接管鼠标与键盘，对元素 ${path} 执行 ${action}`
            : `${action} 元素 ${path}${args?.name ? `（「${args.name}」）` : ''}`,
          scopeText: `窗口 ${handle}「${String(args?.windowTitle || '').slice(0, 60)}」 · 元素路径 ${path}`,
          impactText: allowIntrusive
            ? '这期间会移动你的物理鼠标指针并抢占键盘焦点，你无法同时用自己的键鼠操作；动作结束即归还'
            : args?.impact || '可能触发不可撤销的界面结果（提交/删除/发送一类）',
          undoText: allowIntrusive ? '控制权在动作结束后自动归还；界面副作用通常无法撤销' : (args?.undo || '界面动作通常无法撤销，只能由用户人工回退'),
          items: [],
          digest,
          noteText: '影响对象',
        });
        if (confirmMeta.decision !== 'execute') {
          appendAudit({
            tool: 'computer_ui', action, level, confirm: confirmMeta.decision, ok: false,
            summary: confirmMeta.reason || confirmMeta.decision, targets: [handle, path],
          });
          deny(confirmDenialMessage('computer_ui', confirmMeta.decision, confirmMeta.reason));
        }
        // 一次性凭证：真正执行前再算一遍，参数变了就作废
        const recheck = digestOf({
          tool: 'computer_ui', action, targets: [handle, path],
          params: { text: spec.text ?? null, settleMs: spec.settleMs ?? null, intrusive: allowIntrusive },
        });
        if (recheck !== confirmMeta.digest) {
          deny('确认后参数发生变化，凭证作废：请重新发起这一步。');
        }
      }

      const result = await desk.uia(spec, { timeoutMs: 120000 });
      if (!result.ok) {
        appendAudit({ tool: 'computer_ui', action, level, ok: false, summary: result.error, targets: [handle, path] });
        deny(`UI 动作失败：${result.error || '未知错误'}${result.hints?.length ? `（${result.hints.join('；')}）` : ''}`);
      }
      const d = result.data;
      // 通道判定：让"有没有碰你的鼠标"这件事在回复里可读，而不是靠猜
      const channel = /intrusive/i.test(String(d.detail || ''))
        ? '接管物理键鼠（移动了指针）'
        : /invoke-pattern|value-pattern/.test(String(d.detail || ''))
          ? '非侵入 · 控件自身的 UI 自动化模式'
          : /wm-/.test(String(d.detail || ''))
            ? '非侵入 · 窗口消息直送控件（未调用任何指针 API）'
            : '非侵入';
      const rows = [
        `已执行 ${action} → ${path}  ${d.detail || ''}`.trim(),
        `通道：${channel}`,
        `元素是否仍存在：${d.exists ? '是' : '否（可能已被这次操作销毁）'}  ·  状态是否变化：${d.changed ? '是' : '否'}`,
      ];
      if (d.cursor?.before && d.cursor?.after) {
        rows.push(`鼠标指针：${d.cursor.before.x},${d.cursor.before.y} → ${d.cursor.after.x},${d.cursor.after.y}`);
        if (d.cursor.pointerMoved && /intrusive/i.test(String(d.detail || ''))) {
          rows.push('（本次是接管模式，指针位移由这次动作造成）');
        } else if (d.cursor.pointerMoved) {
          rows.push('（非侵入通道不调用 SetCursorPos / SendInput：这段位移是你自己动鼠标留下的）');
        }
      }
      if (d.restore && (d.restore.pointer || d.restore.foreground)) {
        const bits = [d.restore.pointer ? `指针：${d.restore.pointer}` : '', d.restore.foreground ? `前台：${d.restore.foreground}` : ''].filter(Boolean);
        rows.push(`归还：${bits.join(' · ')}`);
      }
      if (d.verification) {
        rows.push(d.verification === 'observed'
          ? '验证：已确认（界面确实发生了变化）'
          : '验证：只确认到「输入已送达」，界面还没变化——不要当成完成，用 tree/screenshot 复核');
      }
      if (d.after) {
        const after = d.after;
        rows.push(`验证：${after.r} 「${String(after.n).slice(0, 60)}」 enabled=${after.e} offscreen=${after.o}${after.v !== undefined ? ` value="${String(after.v).slice(0, 60)}"` : ''}`);
      }
      if (!d.changed) rows.push('⚠ 界面没有可观察到的变化：不要假设动作成功。用 computer_ui tree 或 computer_screenshot 复核，再决定是否重试（同一动作最多 3 次）。');
      rows.push(`前台窗口：${d.foreground ? `${d.foreground.h} 「${String(d.foreground.title).slice(0, 60)}」` : '（无）'}`);

      appendAudit({
        tool: 'computer_ui', action, level,
        confirm: confirmMeta ? 'execute' : 'none',
        ok: true, summary: `${action} ${path} changed=${d.changed}`,
        targets: [handle, path, d.after?.n].filter(Boolean),
      });
      return { text: rows.join('\n'), h: handle };
    },
  });

  // -------------------------------------------------------------- 操作：键鼠
  register({
    name: 'computer_input',
    description: [
      '注入鼠标键盘（**非侵入模式下默认被拒绝**）。activate / move / click / scroll / drag / type / key（组合键如 CTRL+S）。',
      '它移动的是物理光标、抢的是真键盘焦点——用户就没法同时用鼠标了，所以默认关闭，除非显式 allowIntrusive=true 并由用户点确认窗。',
      '不接管键鼠的替代：computer_ui mode=act 的 invoke/setValue/select/toggle/expand（直接操作控件，不碰指针）。',
      '仍然保留的安全约束：坐标点击必须落在预期窗口内（expectH）；没有及时观察过的坐标被拒绝；键入前核对前台窗口；焦点在密码框时直接拒绝。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['actions'],
      properties: {
        actions: {
          type: 'array',
          description: '按顺序执行的动作列表（失败即停）',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              type: { type: 'string', enum: ['activate', 'move', 'click', 'scroll', 'drag', 'type', 'key'] },
              h: { type: 'string', description: 'activate：目标窗口句柄' },
              x: { type: 'number' }, y: { type: 'number' },
              x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
              button: { type: 'string', enum: ['left', 'right', 'middle'] },
              count: { type: 'number', description: '点击次数（2=双击）' },
              delta: { type: 'number', description: '滚轮增量，负值向下（如 -120）' },
              text: { type: 'string', description: 'type：要键入的文本（支持中文）' },
              combo: { type: 'string', description: 'key：组合键，如 CTRL+S / ALT+TAB / ENTER' },
              expectH: { type: 'string', description: '预期窗口句柄：点击/键入前校验，不匹配就拒绝' },
            },
            required: ['type'],
          },
        },
        expectH: { type: 'string', description: '给整批动作设置默认 expectH' },
        dryRun: { type: 'boolean', description: '只校验不执行（看会被拒绝还是放行）' },
        allowIntrusive: { type: 'boolean', description: '允许接管物理鼠标/键盘（默认 false）。非侵入模式下本工具整体被拒绝；要接管须置 true，届时会弹原生确认窗' },
      },
    },
    output: output(),
    isConcurrencySafe: () => false,
    timeoutMs: 150000,
    async execute(args) {
      requireActive('computer_input');
      const state = loadState();
      const allowIntrusive = Boolean(args?.allowIntrusive);

      // 非侵入模式（默认）：电脑自己干活，鼠标始终归用户。真键鼠注入会移动指针、抢焦点。
      if (state.nonIntrusive !== false && !allowIntrusive) {
        deny([
          '已拒绝：非侵入模式下不接管鼠标与键盘（这是设定的默认行为，保证你能同时用自己的鼠标）。',
          '',
          INTRUSIVE_HINT,
          '',
          '不接管键鼠也能做的事：computer_ui mode=act 用 invoke / setValue / select / toggle / expand / scrollIntoView 直接操作控件；computer_files 直接处理文件；computer_app 启停程序。',
        ].join('\n'));
      }
      if (allowIntrusive) {
        const digest = digestOf({
          tool: 'computer_input', action: 'intrusive-batch',
          targets: [String(args?.expectH ?? '')], params: { count: Array.isArray(args?.actions) ? args.actions.length : 0 },
        });
        const decision = await askConfirm({
          level: 'L3',
          actionText: `接管鼠标与键盘，执行 ${Array.isArray(args?.actions) ? args.actions.length : 0} 个动作`,
          scopeText: `${Array.isArray(args?.actions) ? args.actions.map((a) => a?.type).join(' → ') : ''}${args?.expectH ? ` · 目标窗口 ${args.expectH}` : ''}`,
          impactText: '期间会移动你的物理鼠标指针、抢占键盘焦点：你无法同时用自己的键鼠操作，打字会进到目标窗口',
          undoText: '动作结束即归还控制权；已发生的界面副作用通常无法撤销',
          items: [],
          digest,
          noteText: '影响对象',
        });
        if (decision.decision !== 'execute') {
          appendAudit({ tool: 'computer_input', action: 'intrusive', level: 'L3', confirm: decision.decision, ok: false, summary: decision.reason });
          deny(confirmDenialMessage('computer_input', decision.decision, decision.reason));
        }
      }
      const raw = Array.isArray(args?.actions) ? args.actions : [];
      if (raw.length === 0) deny('actions 不能为空');
      if (raw.length > 30) deny('一次最多 30 个动作；请拆成多步，每步都验证');

      const defaultExpect = args?.expectH ? String(args.expectH) : undefined;
      const prepared = [];
      const notes = [];

      for (const [index, action] of raw.entries()) {
        const type = String(action?.type ?? '');
        if (!['activate', 'move', 'click', 'scroll', 'drag', 'type', 'key'].includes(type)) {
          deny(`第 ${index + 1} 个动作类型不支持：${type}`);
        }
        const item = { ...action, type };
        if (defaultExpect && !item.expectH) item.expectH = defaultExpect;

        if (type === 'key') {
          const reason = deniedKeyCombo(item.combo);
          if (reason) deny(`组合键 ${item.combo} 被拒绝：${reason}（硬红线）`);
        }

        if (type === 'click' || type === 'drag') {
          const px = type === 'click' ? Number(item.x) : Number(item.x1);
          const py = type === 'click' ? Number(item.y) : Number(item.y1);
          if (!Number.isFinite(px) || !Number.isFinite(py)) deny(`第 ${index + 1} 个 ${type} 需要坐标`);
          if (!item.expectH) {
            const coverage = coverageFor(px, py);
            if (!coverage) {
              deny([
                `第 ${index + 1} 个 click/drag 在 (${px},${py}) 没有匹配的近期观察：拒绝盲点坐标。`,
                '先 computer_screenshot（对该窗口或该区域）或 computer_ui mode=tree，然后再点；也可以直接给 expectH。',
              ].join('\n'));
            }
            if (coverage.h) {
              item.expectH = coverage.h;
              notes.push(`第 ${index + 1} 个动作的 expectH 自动沿用最近观察到的窗口 ${coverage.h}`);
            } else {
              // 整屏截图不知道点落在哪个窗口：先命中测试，再把它当作预期窗口
              const hit = await runVerb('hit', { x: px, y: py }, { timeoutMs: 30000 });
              if (hit.ok && hit.data?.room) {
                item.expectH = String(hit.data.room);
                notes.push(`第 ${index + 1} 个动作命中测试得到窗口 ${hit.data.room}「${String(hit.data.title).slice(0, 40)}」，已绑定为 expectH`);
              } else {
                deny(`第 ${index + 1} 个动作无法确定 (${px},${py}) 属于哪个窗口，拒绝执行`);
              }
            }
          }
        }

        if (type === 'type' || type === 'key') {
          if (!item.expectH) {
            deny(`第 ${index + 1} 个 ${type} 需要 expectH（要往哪个窗口输入就必须指明它），否则会对着未知前台窗口盲打`);
          }
        }
        if (type === 'type') {
          const text = String(item.text ?? '');
          if (!text) deny(`第 ${index + 1} 个 type 的 text 为空`);
          if (text.length > 4000) deny('单次键入上限 4000 字符，请分段');
        }
        prepared.push(item);
      }

      const level = prepared.some((a) => a.type === 'click' || a.type === 'type' || a.type === 'key' || a.type === 'drag') ? 'L2' : 'L1';
      const result = await desk.input({ actions: prepared, dryRun: Boolean(args?.dryRun) }, { timeoutMs: 120000 });

      const results = Array.isArray(result.data?.results) ? result.data.results : [];
      const rows = [];
      if (notes.length) rows.push(...notes);
      for (const item of results) {
        const flag = item.ok ? '✓' : '✗';
        rows.push(`${flag} #${item.i} ${item.type} ${item.detail ? `· ${item.detail}` : ''}${item.error ? `· ${item.error}` : ''}`.trim());
        if (item.foreground?.title) rows.push(`    前台：${item.foreground.h} 「${String(item.foreground.title).slice(0, 60)}」`);
      }
      if (result.data?.foreground) {
        rows.push(`结束前台：${result.data.foreground.h} 「${String(result.data.foreground.title).slice(0, 60)}」`);
      }
      if (result.data?.restore && (result.data.restore.pointer || result.data.restore.foreground)) {
        const bits = [result.data.restore.pointer ? `指针：${result.data.restore.pointer}` : '', result.data.restore.foreground ? `前台：${result.data.restore.foreground}` : ''].filter(Boolean);
        rows.push(`归还：${bits.join(' · ')}`);
      }
      if (result.ok && result.data?.verification) {
        rows.push('验证：输入已送达（"已发送"不等于完成：请用 computer_ui / computer_screenshot 确认界面真的变了）');
      }
      if (!result.ok) {
        appendAudit({
          tool: 'computer_input', action: prepared.map((a) => a.type).join(','), level,
          ok: false, summary: result.error || 'input failed', targets: prepared.map((a) => a.expectH).filter(Boolean),
        });
        deny([
          `键鼠注入未全部完成：${result.error || '未知错误'}`,
          ...rows,
          '同一动作最多重试 3 次；换通道（结构化 UIA）比重复盲试更可靠。',
        ].join('\n'));
      }
      rows.push('已按顺序执行完。请用 computer_screenshot / computer_ui 验证结果，再决定下一步。');
      appendAudit({
        tool: 'computer_input', action: prepared.map((a) => a.type).join(','), level,
        ok: true, summary: `${prepared.length} actions`,
        targets: prepared.map((a) => a.expectH).filter(Boolean),
      });
      return { text: rows.join('\n') };
    },
  });

  // -------------------------------------------------------------- 操作：应用与窗口
  // -------------------------------------------------------------- 等待
  register({
    name: 'computer_wait',
    description: [
      '等一个条件成立再往下走，最多等到 timeoutMs（默认 15 秒）。',
      'kind=window：等标题匹配正则的窗口出现；kind=control：等某个窗口里出现角色/名称匹配的控件；kind=file：等路径出现。',
      'gone=true 反过来等它消失（关掉对话框、删完文件）。',
      '整个等待在一个进程里轮询，比反复调 windows/tree 便宜几十倍；按 Esc 也能立刻打断。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['window', 'control', 'file'] },
        title: { type: 'string', description: 'kind=window：窗口标题正则（不区分大小写）' },
        h: { type: 'string', description: 'kind=control：在哪个窗口里等（computer_windows 返回的 h）' },
        role: { type: 'string', description: 'kind=control：控件角色正则，如 Button / Edit / Document' },
        name: { type: 'string', description: 'kind=control：控件名称正则' },
        path: { type: 'string', description: 'kind=file：文件或目录路径' },
        gone: { type: 'boolean', description: 'true=等它消失；默认 false=等它出现' },
        timeoutMs: { type: 'number', description: '最长等待毫秒，默认 15000，上限 300000' },
        pollMs: { type: 'number', description: '轮询间隔毫秒，默认 250' },
      },
    },
    output: output(),
    isConcurrencySafe: () => true,
    timeoutMs: 330000,
    async execute(args) {
      // 只读等待：暂停时也允许观察；但停止标记会由 desk.ps1 在循环里打断它
      requireActive('computer_wait', true);
      const kind = ['window', 'control', 'file'].includes(args?.kind) ? String(args.kind) : '';
      if (!kind) deny('kind 必须是 window / control / file 之一');
      const timeoutMs = Number.isFinite(args?.timeoutMs)
        ? Math.max(500, Math.min(300000, Math.floor(args.timeoutMs)))
        : 15000;
      const pollMs = Number.isFinite(args?.pollMs) ? Math.max(50, Math.min(5000, Math.floor(args.pollMs))) : 250;
      const spec = {
        kind,
        title: String(args?.title ?? ''),
        h: String(args?.h ?? ''),
        role: String(args?.role ?? ''),
        name: String(args?.name ?? ''),
        path: String(args?.path ?? ''),
        gone: args?.gone === true,
        timeoutMs,
        pollMs,
      };
      const result = await runVerb('wait', spec, { timeoutMs: timeoutMs + 25000 });
      if (!result.ok) {
        deny(`等待失败：${result.error || '未知错误'}${result.hints?.length ? `（${result.hints.join('；')}）` : ''}`);
      }
      const data = result.data ?? {};
      const waited = Math.round(Number(data.waitedMs) || 0);
      if (!data.found) {
        const target = kind === 'window' ? `匹配 /${spec.title}/ 的窗口`
          : kind === 'control' ? `角色/${spec.role}/ 名称/${spec.name}/ 的控件`
            : homeShorthand(spec.path);
        deny([
          `等了 ${(waited / 1000).toFixed(1)} 秒，${spec.gone ? `「${target}」仍然存在` : `没等到 ${target}`}。`,
          '别原地重试同样的等待：先观察现在的真实状态（computer_windows / computer_ui tree / computer_screenshot），判断是标题/名称写错了，还是这一步根本没触发。',
        ].join(''));
      }
      const found = data.found;
      const head = spec.gone ? `已确认消失（等了 ${(waited / 1000).toFixed(1)} 秒）` : `已等到（${(waited / 1000).toFixed(1)} 秒）`;
      const rows = [head];
      if (kind === 'window') {
        rows.push(`  窗口 ${found.h} 「${found.title ?? ''}」 · ${found.cls || '类名未知'} · pid=${found.pid ?? '?'} · ${found.w ?? '?'}x${found.hh ?? '?'} @${found.x ?? '?'},${found.y ?? '?'}`);
        if (found.iconic) rows.push('  注意：这个窗口当前是最小化的，里面的控件可能读不到。');
      } else if (kind === 'control') {
        const bounds = found.b ? `${found.b.x},${found.b.y} ${found.b.w}x${found.b.h}` : '位置未知';
        const flags = [];
        if (found.e === false) flags.push('disabled');
        if (found.o) flags.push('offscreen');
        if (found.f) flags.push('有焦点');
        rows.push(`  控件 ${found.r ?? '?'}${found.n ? ` "${String(found.n).replace(/\s+/g, ' ').slice(0, 80)}"` : ''} · 路径 ${found.p ?? '?'} · ${bounds}${flags.length ? ` (${flags.join(',')})` : ''}`);
        if (found.nh) rows.push(`  可以直接对它动手：computer_ui mode=act h=${found.h ?? String(args?.h ?? '')} path=${found.p}`);
      } else {
        rows.push(`  ${homeShorthand(found.path || spec.path)}${Number.isFinite(found.size) ? ` · ${humanSize(found.size)}` : ''}`);
      }
      return { text: rows.join('\n') };
    },
  });

  register({
    name: 'computer_app',
    description: [
      '应用与窗口控制：launch 启动程序（白名单内直接启动，白名单外要用户确认）、activate 切到前台、',
      'minimize/maximize/restore 改变窗口状态、close 关闭窗口（L3，可能丢未保存内容）、kill 结束进程（L3）。',
      '受保护进程（explorer/lsass/winlogon 等）一律拒绝结束。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['launch', 'activate', 'minimize', 'maximize', 'restore', 'close', 'kill'] },
        h: { type: 'string', description: '窗口句柄（activate/minimize/maximize/restore/close 用）' },
        exe: { type: 'string', description: 'launch 的可执行文件名或绝对路径，如 notepad.exe' },
        args: { type: 'array', items: { type: 'string' }, description: 'launch 的参数' },
        pid: { type: 'number', description: 'kill 的进程号' },
        waitMs: { type: 'number', description: 'launch 后等待窗口出现的毫秒数，默认 1200' },
      },
    },
    output: output(),
    isConcurrencySafe: () => false,
    timeoutMs: 150000,
    async execute(args) {
      requireActive('computer_app');
      const state = loadState();
      const action = String(args?.action ?? '');

      if (action === 'launch') {
        const exe = String(args?.exe ?? '').trim();
        if (!exe) deny('launch 需要 exe');
        const base = basename(exe).toLowerCase();
        const allowed = state.allowedApps.includes(base);
        if (!allowed) {
          const digest = digestOf({ tool: 'computer_app', action: 'launch', targets: [exe], params: args?.args ?? null });
          const decision = await askConfirm({
            level: 'L3',
            actionText: `启动不在白名单里的程序：${exe}`,
            scopeText: `可执行文件 ${exe}`,
            impactText: '未知程序可能修改系统、弹出权限请求或连接网络；来源不明的安装包会写注册表/服务',
            undoText: '通常可以关闭窗口，但程序对系统的写入不一定能干净撤销',
            items: [],
            digest,
            noteText: '影响对象',
          });
          if (decision.decision !== 'execute') {
            appendAudit({ tool: 'computer_app', action: 'launch', level: 'L3', confirm: decision.decision, ok: false, summary: decision.reason, targets: [exe] });
            deny(confirmDenialMessage('computer_app', decision.decision, decision.reason));
          }
        }
        const argv = Array.isArray(args?.args) ? args.args.map((a) => String(a)) : [];
        // 单实例程序（如 Notepad、浏览器）会把参数转交给已有进程然后自己退出，
        // 所以不能只按 pid 找窗口：先记下当前窗口集合，再取差集。
        const beforeHandles = new Set();
        const beforeList = await desk.windows({ limit: 80 }, { timeoutMs: 30000 });
        if (beforeList.ok) {
          for (const w of beforeList.data.windows ?? []) beforeHandles.add(w.h);
        }
        const spawned = await runVerb('spawn', { exe, args: argv }, { timeoutMs: 45000 });
        if (!spawned.ok) {
          deny(`启动失败：${spawned.error || '未知错误'}${spawned.hints?.length ? `（${spawned.hints.join('；')}）` : ''}`);
        }
        const childPid = Number(spawned.data?.pid) || 0;
        const waitMs = Number.isFinite(args?.waitMs) ? Math.max(200, Math.min(15000, Math.floor(args.waitMs))) : 1200;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        // 等到窗口出现再报告，避免「已启动」但用户看不到
        let windowInfo = null;
        let newWindows = [];
        for (let attempt = 0; attempt < 6 && !windowInfo; attempt += 1) {
          const list = await desk.windows({ limit: 80 }, { timeoutMs: 30000 });
          if (list.ok) {
            const windows = list.data.windows ?? [];
            windowInfo = windows.find((w) => w.pid === childPid) || null;
            newWindows = windows.filter((w) => !beforeHandles.has(w.h) && !w.iconic);
            if (!windowInfo) windowInfo = newWindows[0] ?? null;
          }
          if (!windowInfo) await new Promise((resolve) => setTimeout(resolve, 400));
        }
        // 宿主是以隐藏窗口方式起子进程的，新程序可能继承「隐藏」的显示状态，
        // 表现为「启动了但看不到」。这里让它可见并置顶，但**不抢前台**。
        if (windowInfo) {
          const shown = await runVerb('window', { h: String(windowInfo.h), action: 'show' }, { timeoutMs: 30000 });
          await new Promise((resolve) => setTimeout(resolve, 220));
          const list2 = await desk.windows({ limit: 80 }, { timeoutMs: 30000 });
          if (list2.ok) {
            const fresh = (list2.data.windows ?? []).find((w) => w.h === String(windowInfo.h));
            if (fresh) windowInfo = fresh;
          }
        }
        appendAudit({ tool: 'computer_app', action: 'launch', level: allowed ? 'L1' : 'L3', confirm: allowed ? 'none' : 'execute', ok: true, summary: `launch ${exe}`, targets: [exe] });
        return {
          text: [
            `已启动 ${exe}${argv.length ? ` ${argv.join(' ')}` : ''}（pid=${childPid || '?'}${spawned.data?.hasExited ? '，启动器已退出' : ''}）`,
            windowInfo
              ? `对应窗口：${windowInfo.h} 「${String(windowInfo.title).slice(0, 70)}」 ${windowInfo.w}x${windowInfo.hh}@${windowInfo.x},${windowInfo.y}\n窗口已显示并置顶，但没有抢你的前台（焦点还在你那边）；需要切过去时显式调 computer_app action=activate。`
              : '暂未看到新的顶层窗口（有些程序启动慢、单实例转交给已有进程、或只在托盘运行）：稍后用 computer_windows 再找。',
            newWindows.length > 1 ? `其它新出现的窗口：${newWindows.slice(1, 4).map((w) => `${w.h}「${String(w.title).slice(0, 30)}」`).join('、')}` : '',
          ].filter(Boolean).join('\n'),
        };
      }

      if (action === 'kill') {
        const pid = Number(args?.pid);
        if (!Number.isFinite(pid) || pid <= 0) deny('kill 需要 pid');
        const list = await desk.windows({ limit: 80 }, { timeoutMs: 30000 });
        const procName = list.ok ? String((list.data.windows ?? []).find((w) => w.pid === pid)?.proc ?? '') : '';
        if (procName && state.protectedProcesses.includes(procName.toLowerCase())) {
          deny(`${procName}（pid=${pid}）是受保护进程，拒绝结束（硬红线：结束它会锁死桌面或系统）`);
        }
        const digest = digestOf({ tool: 'computer_app', action: 'kill', targets: [String(pid)], params: null });
        const decision = await askConfirm({
          level: 'L3',
          actionText: `结束进程 pid=${pid}${procName ? `（${procName}）` : ''}`,
          scopeText: `进程 ${pid} 及其子进程`,
          impactText: '未保存的数据会丢失；进程可能持有文件锁或服务状态',
          undoText: '无法撤销，只能重新启动程序',
          items: [],
          digest,
          noteText: '影响对象',
        });
        if (decision.decision !== 'execute') {
          appendAudit({ tool: 'computer_app', action: 'kill', level: 'L3', confirm: decision.decision, ok: false, summary: decision.reason });
          deny(confirmDenialMessage('computer_app', decision.decision, decision.reason));
        }
        try { process.kill(pid); } catch (err) { deny(`结束进程失败：${err.code === 'EPERM' ? '权限不足（这个进程受保护，或它不是你有权结束的）' : describeFsError(err)}`); }
        appendAudit({ tool: 'computer_app', action: 'kill', level: 'L3', confirm: 'execute', ok: true, summary: `kill ${pid}` });
        return { text: `已请求结束进程 ${pid}${procName ? `（${procName}）` : ''}。用 computer_windows 复核它是否真的消失。` };
      }

      const handle = String(args?.h ?? '').trim();
      if (!handle) deny(`${action} 需要 h（窗口句柄）`);

      if (action === 'close') {
        const digest = digestOf({ tool: 'computer_app', action: 'close', targets: [handle], params: null });
        const decision = await askConfirm({
          level: 'L3',
          actionText: `关闭窗口 ${handle}`,
          scopeText: `窗口 ${handle}${args?.windowTitle ? `「${args.windowTitle}」` : ''}`,
          impactText: args?.impact || '窗口关闭，未保存的内容会丢失；若弹出「是否保存」对话框，需要后续处理',
          undoText: '无法撤销（可以重新打开，但未保存的编辑内容未必能恢复）',
          items: [],
          digest,
          noteText: '影响对象',
        });
        if (decision.decision !== 'execute') {
          appendAudit({ tool: 'computer_app', action: 'close', level: 'L3', confirm: decision.decision, ok: false, summary: decision.reason, targets: [handle] });
          deny(confirmDenialMessage('computer_app', decision.decision, decision.reason));
        }
      }

      const result = await runVerb('window', { h: handle, action }, { timeoutMs: 45000 });
      if (!result.ok) deny(`窗口操作失败：${result.error || '未知错误'}`);
      const d = result.data;
      const after = d.after;
      appendAudit({ tool: 'computer_app', action, level: action === 'close' ? 'L3' : 'L1', confirm: action === 'close' ? 'execute' : 'none', ok: true, summary: `${action} ${handle}`, targets: [handle] });
      return {
        text: [
          `已执行 ${action} → ${handle}  ${d.detail || ''}`.trim(),
          after ? `当前状态：${after.iconic ? '最小化' : '已还原'} ${after.w}x${after.hh}@${after.x},${after.y} 「${String(after.title).slice(0, 60)}」` : '窗口已不再存在（关闭成功）。',
          d.foreground ? `前台窗口：${d.foreground.h} 「${String(d.foreground.title).slice(0, 60)}」` : '',
        ].filter(Boolean).join('\n'),
      };
    },
  });

  // -------------------------------------------------------------- 操作：文件
  register({
    name: 'computer_files',
    description: [
      '文件批量操作（不经 GUI，直接走文件系统，比鼠标点资源管理器可靠）：list/mkdir/copy/move/rename/delete/undo。',
      '删除不是真删：文件会被移到插件隔离区并可 undo；permanent=true 才是永久删除（L3，无法撤销）。',
      '所有改写类操作先出计划 → 有风险就弹原生确认 → 执行 → 记撤销清单；系统目录、Program Files、DSH 目录是硬红线。',
      '支持最后一段通配（*.pdf），不支持 ** 递归。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['op'],
      properties: {
        op: { type: 'string', enum: ['list', 'mkdir', 'copy', 'move', 'rename', 'delete', 'undo'] },
        sources: { type: 'array', items: { type: 'string' }, description: '来源路径（list 时可多个；支持末段通配）' },
        target: { type: 'string', description: 'copy/move 的目标目录或目标文件' },
        name: { type: 'string', description: 'rename 的新名字（不含路径）' },
        overwrite: { type: 'boolean', description: '允许覆盖已存在的目标，默认 false' },
        permanent: { type: 'boolean', description: 'delete 时永久删除（不可撤销），默认 false' },
        runId: { type: 'string', description: 'undo 时要撤销的 runId' },
      },
    },
    output: output({ runId: { type: 'string' } }),
    isConcurrencySafe: () => false,
    timeoutMs: 240000,
    async execute(args, exec) {
      const state = loadState();
      const op = String(args?.op ?? '');
      requireActive('computer_files', op === 'list');
      if (!['list', 'mkdir', 'copy', 'move', 'rename', 'delete', 'undo'].includes(op)) {
        deny('op 必须是 list/mkdir/copy/move/rename/delete/undo');
      }

      if (op === 'undo') {
        const runId = String(args?.runId ?? '').trim();
        if (!runId) deny('undo 需要 runId（可用 computer_audit action=runs 查）');
        const result = undoRun(runId, { agent: exec?.agent?.id });
        if (!result.ok) deny(`撤销未完全成功：${(result.failed ?? []).map((f) => `${homeShorthand(f.from)}: ${f.error}`).join('；') || result.error}`);
        return {
          text: [
            `已撤销 ${runId}：${result.restored.length} 项复原`,
            ...result.restored.map((r) => `  ${r.action} ${homeShorthand(r.path)}`),
          ].join('\n'),
          runId,
        };
      }

      const sources = (Array.isArray(args?.sources) ? args.sources : []).map((s) => String(s));
      if (sources.length === 0) deny(`${op} 需要 sources`);

      const plan = planOperation({
        op,
        sources,
        target: args?.target ? String(args.target) : '',
        name: args?.name ? String(args.name) : '',
        overwrite: Boolean(args?.overwrite),
        permanent: Boolean(args?.permanent),
        allowRoots: state.allowRoots,
      });

      if (op === 'list') {
        const rows = [];
        const when = (iso) => {
          if (!iso) return '          ';
          const d = new Date(iso);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        };
        if (plan.files?.length) {
          rows.push(`文件（${plan.files.length}）：`);
          for (const f of plan.files.slice(0, 120)) rows.push(`  ${when(f.mtime)}  ${humanSize(f.size).padStart(8)}  ${homeShorthand(f.path)}`);
          if (plan.files.length > 120) rows.push(`  … 另有 ${plan.files.length - 120} 个`);
        }
        if (plan.dirs?.length) {
          rows.push(`子目录（${plan.dirs.length}）：`);
          for (const d of plan.dirs.slice(0, 60)) rows.push(`  ${when(d.mtime)}  ${homeShorthand(d.path)}`);
        }
        for (const miss of plan.missing ?? []) rows.push(`未找到 ${homeShorthand(miss.source)}：${miss.reason}`);
        for (const problem of plan.problems ?? []) rows.push(`注意：${problem}`);
        if (rows.length === 0) rows.push('目录是空的。');
        appendAudit({ tool: 'computer_files', action: 'list', level: 'L0', ok: true, summary: `${plan.files?.length ?? 0} files`, targets: sources });
        return { text: rows.join('\n') };
      }

      // 计划阶段就判定为不可行：直接报告，不执行、也不打扰用户
      if ((plan.problems ?? []).length > 0) {
        appendAudit({ tool: 'computer_files', action: op, level: plan.level, ok: false, summary: 'plan rejected', targets: sources, error: plan.problems[0] });
        deny([
          `计划未通过，未执行任何改动：`,
          ...plan.problems.map((p) => `  · ${p}`),
          ...(plan.missing ?? []).map((m) => `  · ${homeShorthand(m.source)}：${m.reason}`),
          '修正 sources/target 后再来一次。',
        ].join('\n'));
      }

      const bulk = state.bulkThreshold ?? 10;
      const highRiskL2 = plan.overwriteCount >= bulk
        || (plan.op === 'move' && plan.count >= bulk)
        || (plan.warnings ?? []).some((w) => w.includes('allowRoots'));
      const mustConfirm = needsConfirm(plan.level, highRiskL2);
      let confirmDecision = 'none';

      const targetList = plan.entries.map((e) => e.from);
      const fingerprint = digestOf({
        tool: 'computer_files', action: op, targets: targetList,
        params: { target: plan.entries.map((e) => e.to ?? null), overwrite: Boolean(args?.overwrite), permanent: Boolean(args?.permanent) },
      });

      if (mustConfirm) {
        const actionText = op === 'delete'
          ? `${args?.permanent ? '永久删除' : '删除（移入隔离区）'} ${plan.entries.length} 项`
          : `${op} ${plan.entries.length} 项${plan.overwriteCount ? `（其中 ${plan.overwriteCount} 项会覆盖已有文件）` : ''}`;
        const scopeText = plan.entries.slice(0, 3).map((e) => `${homeShorthand(e.from)}${e.to ? ` → ${homeShorthand(e.to)}` : ''}`).join('；')
          + (plan.entries.length > 3 ? ` … 共 ${plan.entries.length} 项` : '');
        const impactText = args?.permanent
          ? '文件被直接销毁，不进入回收站，也不进插件隔离区'
          : op === 'delete'
            ? `文件移到插件隔离区（${trashDir()}），保留 ${state.trashRetentionDays} 天后清理`
            : `${plan.overwriteCount} 个目标会被覆盖，原件先备份到插件备份区`;
        const undoText = args?.permanent
          ? '无法撤销'
          : op === 'delete'
            ? `可撤销：computer_files op=undo runId=${plan.runId}`
            : op === 'move'
              ? `可撤销：computer_files op=undo runId=${plan.runId}`
              : `可撤销：computer_files op=undo runId=${plan.runId}`;

        const decision = await askConfirm({
          level: plan.level,
          actionText,
          scopeText,
          impactText,
          undoText,
          items: plan.entries.map((e) => (e.to ? `${homeShorthand(e.from)}  →  ${homeShorthand(e.to)}` : homeShorthand(e.from))),
          digest: fingerprint,
          noteText: '影响对象',
        });
        if (decision.decision !== 'execute') {
          appendAudit({
            tool: 'computer_files', action: op, level: plan.level, confirm: decision.decision,
            ok: false, summary: decision.reason || decision.decision, targets: targetList,
          });
          deny(confirmDenialMessage('computer_files', decision.decision, decision.reason));
        }
        confirmDecision = decision.decision;
      }

      // 执行前重新核对目标集：确认期间文件系统可能已经变了（状态漂移就作废）
      const recheck = planOperation({
        op,
        sources,
        target: args?.target ? String(args.target) : '',
        name: args?.name ? String(args.name) : '',
        overwrite: Boolean(args?.overwrite),
        permanent: Boolean(args?.permanent),
        allowRoots: state.allowRoots,
        runId: plan.runId,
      });
      const recheckFingerprint = digestOf({
        tool: 'computer_files', action: op,
        targets: recheck.entries.map((e) => e.from),
        params: { target: recheck.entries.map((e) => e.to ?? null), overwrite: Boolean(args?.overwrite), permanent: Boolean(args?.permanent) },
      });
      if (mustConfirm && recheckFingerprint !== fingerprint) {
        deny('确认之后目标集合发生变化（有文件新增/消失），本次凭证作废：请重新发起并再次确认。');
      }

      const applied = executePlan(recheck, { agent: exec?.agent?.id, confirm: confirmDecision });
      const rows = [
        `已执行 ${op}：成功 ${applied.applied.length} 项${applied.failed.length ? `，失败 ${applied.failed.length} 项` : ''}`,
        `runId：${applied.runId}${applied.undoable ? `（可撤销：computer_files op=undo runId=${applied.runId}）` : '（不可撤销）'}`,
      ];
      for (const e of applied.applied.slice(0, 40)) {
        rows.push(`  ✓ ${e.action} ${homeShorthand(e.from)}${e.to ? ` → ${homeShorthand(e.to)}` : ''}${e.backup ? '（原件已备份）' : ''}`);
      }
      if (applied.applied.length > 40) rows.push(`  … 另有 ${applied.applied.length - 40} 项`);
      for (const f of applied.failed.slice(0, 10)) rows.push(`  ✗ ${homeShorthand(f.from)}：${f.error}`);
      if (applied.trashDir && op === 'delete') rows.push(`隔离区：${applied.trashDir}`);
      return { text: rows.join('\n'), runId: applied.runId };
    },
  });

  // -------------------------------------------------------------- 审计
  // -------------------------------------------------------------- 工具集管理
  register({
    name: 'computer_tools',
    description: [
      '工具集管理。lite/lazy 预设只注册了一部分工具，用这里查看分组，并把需要的分组现场加载进来（不用重载插件）。',
      'action=list：看当前预设、已加载哪些、还有哪些分组没加载。',
      'action=enable group=browser：把浏览器那一组（browser_*）加载进来；govern=审计；desktop=桌面操作；files=文件；',
      '一次调用可以只加载一个分组，需要多个就多调一次。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'enable'] },
        group: { type: 'string', enum: Object.keys(TOOL_GROUPS), description: 'enable 时要加载的分组' },
      },
    },
    output: output(),
    isConcurrencySafe: () => false,
    timeoutMs: 15000,
    async execute(args) {
      requireActive('computer_tools', true);
      const action = args?.action === 'enable' ? 'enable' : 'list';
      if (action === 'list') {
        const loaded = [...registeredNames];
        const notLoaded = new Map();
        for (const item of pendingTools) {
          if (!notLoaded.has(item.group)) notLoaded.set(item.group, []);
          notLoaded.get(item.group).push(item.definition.name);
        }
        const rows = [
          `当前预设：${toolMode}（${(PRESETS[toolMode] ?? PRESETS.full).map((g) => `${g}=${TOOL_GROUPS[g]}`).join('，')}）`,
          `已加载 ${loaded.length} 个：${loaded.join(', ')}`,
        ];
        if (notLoaded.size === 0) {
          rows.push('所有分组都已加载，没有可再加载的工具。');
        } else {
          rows.push('还没加载的分组：');
          for (const [group, names] of notLoaded) {
            rows.push(`  ${group}（${TOOL_GROUPS[group]}）：${names.join(', ')}`);
            rows.push(`    需要就调用 computer_tools action=enable group=${group}`);
          }
        }
        return { text: rows.join('\n') };
      }
      const group = String(args?.group ?? '');
      if (!TOOL_GROUPS[group]) {
        deny(`未知分组：${group || '（未指定）'}。可选：${Object.keys(TOOL_GROUPS).join(' / ')}`);
      }
      const added = enableGroup(group);
      if (added.length === 0) {
        return { text: `${group}（${TOOL_GROUPS[group]}）这一组已经没有待加载的工具了。` };
      }
      appendAudit({ tool: 'computer_tools', action: 'enable', level: 'L1', ok: true, summary: `加载分组 ${group}：${added.join(', ')}` });
      return {
        text: [
          `已加载 ${group}（${TOOL_GROUPS[group]}）${added.length} 个工具：`,
          `  ${added.join(', ')}`,
          '现在可以直接调用它们了。',
        ].join('\n'),
      };
    },
  });

  // -------------------------------------------------------------- 审计
  register({
    name: 'computer_audit',
    description: [
      '读最近的审计记录与可撤销操作清单。只读。',
      '任务开始前看一眼最近做过什么、任务结束后回报「改了什么、怎么撤」，都靠它。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'number', description: '返回多少条记录，默认 15' },
        action: { type: 'string', enum: ['recent', 'runs'], description: 'recent=审计日志；runs=可撤销批次' },
      },
    },
    output: output(),
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    async execute(args) {
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(100, Math.floor(args.limit))) : 15;
      const action = args?.action === 'runs' ? 'runs' : 'recent';
      if (action === 'runs') {
        const runs = listManifests(limit);
        const rows = [`可撤销批次（最近 ${runs.length} 个）：`];
        if (runs.length === 0) rows.push('  （没有可用撤销的批次）');
        for (const run of runs) {
          rows.push(`  ${run.runId}  ${run.at}  ${run.op}  ${run.entries?.length ?? 0} 项  ${run.undoable ? '可撤销' : '不可撤销'}`);
        }
        return { text: rows.join('\n') };
      }
      const entries = readRecent(limit);
      const rows = [`最近 ${entries.length} 条审计：`];
      if (entries.length === 0) rows.push('  （还没有记录）');
      for (const e of entries) {
        const flags = [e.level, e.confirm !== 'none' ? `confirm=${e.confirm}` : '', e.ok ? 'ok' : 'FAIL'].filter(Boolean).join(' ');
        rows.push(`  ${e.ts}  ${e.tool}${e.action ? `.${e.action}` : ''}  [${flags}]  ${e.summary || ''}${e.error ? ` :: ${e.error}` : ''}`);
      }
      return { text: rows.join('\n') };
    },
  });

  // -------------------------------------------------------------- 总闸
  register({
    name: 'computer_pause',
    description: [
      '总闸（kill switch）。pause 立刻冻结所有会动电脑的操作（只读工具仍可用）；resume 恢复（需用户确认）。',
      '发现情况不对、界面和你预期不一致、或者用户喊停时，第一件事是 pause。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['pause', 'resume', 'state'] },
        reason: { type: 'string', description: '暂停原因，会写进审计' },
      },
    },
    output: output(),
    isConcurrencySafe: () => false,
    timeoutMs: 120000,
    async execute(args, exec) {
      const action = String(args?.action ?? 'state');
      const state = loadState();
      if (action === 'state') {
        return { text: `当前状态：${state.paused ? '已暂停' : '允许执行'}` };
      }
      if (action === 'pause') {
        saveState({ paused: true });
        appendAudit({ tool: 'computer_pause', action: 'pause', level: 'L1', ok: true, summary: args?.reason || 'paused', agent: exec?.agent?.id });
        return { text: `已暂停：除只读工具外，所有会改动电脑的动作都会被拒绝。原因：${args?.reason || '（未说明）'}` };
      }
      if (state.paused === false) {
        return { text: '当前本来就没有暂停，不需要 resume。' };
      }
      const digest = digestOf({ tool: 'computer_pause', action: 'resume', targets: ['paused'], params: null });
      const decision = await askConfirm({
        level: 'L2',
        actionText: '恢复 agent 对本机的操作权限',
        scopeText: '本机桌面（鼠标、键盘、窗口、文件）',
        impactText: '恢复后 agent 可以继续执行你之前叫停的操作',
        undoText: '随时可以再次 pause',
        items: [],
        digest,
        noteText: '影响对象',
      });
      if (decision.decision !== 'execute') {
        appendAudit({ tool: 'computer_pause', action: 'resume', level: 'L2', confirm: decision.decision, ok: false, summary: decision.reason });
        deny(confirmDenialMessage('computer_pause', decision.decision, decision.reason));
      }
      saveState({ paused: false });
      appendAudit({ tool: 'computer_pause', action: 'resume', level: 'L2', confirm: 'execute', ok: true, summary: 'resumed', agent: exec?.agent?.id });
      return { text: '已恢复执行权限。' };
    },
  });

  // -------------------------------------------------------------- 浏览器（CDP，非侵入）
  // 这些工具在页面内部操作：不移动你的鼠标、不抢键盘焦点，也不使用你正在用的浏览器。
  register({
    name: 'browser_status',
    description: '浏览器（CDP）状态：是否已启动、版本、当前页面、隔离配置目录。只读。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: output(),
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute() {
      const state = loadState();
      const info = await sessionInfo();
      const rows = [];
      if (!info) {
        rows.push('浏览器：未启动（首次调用 browser_open 会自动启动一个独立配置目录的实例，不碰你正在用的浏览器）');
      } else {
        rows.push(`浏览器：运行中 · ${info.version || '未知版本'} · pid=${info.pid} · 端口 ${info.port} · ${info.headless ? '无头（完全不打扰你）' : '可见窗口'}`);
        rows.push(`可执行文件：${info.exe}`);
        rows.push(`隔离配置目录：${info.userDataDir}`);
        rows.push(info.page ? `当前页面：${info.page.url}\n标题：${info.page.title}` : '当前没有可用页面（browser_open 会新建）');
      }
      rows.push(`默认模式：${state.browser?.headless !== false ? '无头' : '可见'}（state.json 的 browser.headless 可改）`);
      rows.push('这些工具在页面内部操作，不动你的鼠标键盘。');
      return { text: rows.join('\n') };
    },
  });

  register({
    name: 'browser_open',
    description: [
      '启动/复用隔离浏览器并打开 URL（默认无头模式，不会弹窗、不抢焦点）。',
      'visible=true 会开可见窗口以便人工登录——这会抢一次前台，属例外情况。',
      '用的是插件自己的配置目录：不会碰你正在用的 Edge/Chrome 的书签、标签、登录态。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: '要打开的地址（含 http:// / https:// / file://）' },
        visible: { type: 'boolean', description: '开可见窗口（默认 false=无头）' },
        reload: { type: 'boolean', description: '忽略缓存重新加载' },
      },
    },
    output: output(),
    isConcurrencySafe: () => false,
    timeoutMs: 120000,
    async execute(args) {
      requireActive('browser_open');
      const url = String(args?.url ?? '').trim();
      if (!url) deny('browser_open 需要 url');
      if (!/^(https?|file):\/\//i.test(url)) deny('url 必须是 http:// / https:// / file:// 开头');
      const state = loadState();
      const visible = Boolean(args?.visible);
      const live = await ensureSession(state, { visible });
      const info = await browserNavigate(live, url, { waitMs: 15000 });
      appendAudit({
        tool: 'browser_open', action: 'navigate', level: 'L1', ok: true,
        summary: `open ${url.slice(0, 120)}`, targets: [url],
      });
      return {
        text: [
          `已打开：${info.url}`,
          `标题：${info.title || '(空)'}`,
          `浏览器：${live.headless ? '无头（不打扰你）' : '可见窗口'} · pid=${live.pid} · 配置目录 ${live.userDataDir}`,
          '下一步：browser_read mode=elements 拿选择器 → browser_act → browser_wait/browser_read 验证。',
        ].join('\n'),
      };
    },
  });

  register({
    name: 'browser_read',
    description: [
      '读当前页面：mode=text 取正文与链接；mode=elements 列出可交互元素及其**稳定 CSS 选择器**（后续 browser_act 直接用）；',
      'mode=screenshot 页面截图（可 ocr=true 变成带坐标文字，用于 canvas/iframe 这类读不到 DOM 的部分）。只读。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['text', 'elements', 'screenshot'], description: '默认 text' },
        ocr: { type: 'boolean', description: 'mode=screenshot 时是否 OCR，默认 false' },
        fullPage: { type: 'boolean', description: 'mode=screenshot 时截整页（越过视口，适合长表单/设置页），默认 false' },
        limit: { type: 'number', description: 'elements 最多返回多少个，默认 60' },
      },
    },
    output: output({ path: { type: 'string' } }),
    isConcurrencySafe: () => true,
    timeoutMs: 120000,
    async execute(args) {
      requireActive('browser_read', true);
      const state = loadState();
      const live = await ensureSession(state);
      const mode = ['text', 'elements', 'screenshot'].includes(args?.mode) ? args.mode : 'text';
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(120, Math.floor(args.limit))) : 60;

      if (mode === 'screenshot') {
        const shot = await browserScreenshot(live, { ocr: Boolean(args?.ocr), fullPage: args?.fullPage === true });
        const rows = [`页面截图：${shot.path}`, `${shot.w}×${shot.h} · ${shot.title}`, `URL：${shot.url}`];
        if (shot.ocr?.lines?.length) {
          rows.push(`OCR（${shot.ocr.lang || '?'}）：`);
          for (const line of shot.ocr.lines.slice(0, 60)) rows.push(`  ${line.x},${line.y} ${line.w}x${line.h}  ${line.text}`);
        } else if (args?.ocr) {
          rows.push(`OCR：${shot.ocr?.error || '没有识别到文字'}`);
        }
        appendAudit({ tool: 'browser_read', action: 'screenshot', level: 'L0', ok: true, summary: `${shot.w}x${shot.h}`, evidence: [shot.path] });
        return { text: rows.join('\n'), path: shot.path };
      }

      if (mode === 'elements') {
        const list = await readElements(live);
        const rows = [`可交互元素（${list.length} 个，选择器可直接用于 browser_act）：`];
        for (const el of list.slice(0, limit)) {
          const bits = [`[${el.sel}]`, el.tag, el.type ? `type=${el.type}` : '', el.disabled ? 'disabled' : '', `"${el.text}"`, el.href ? `→ ${el.href}` : ''];
          rows.push(`  ${bits.filter(Boolean).join(' ')}`);
        }
        if (list.length > limit) rows.push(`  … 另有 ${list.length - limit} 个未列出`);
        if (list.length === 0) rows.push('  （没有找到可交互元素：可能是 canvas/iframe 渲染，用 mode=screenshot + ocr=true）');
        return { text: rows.join('\n') };
      }

      const page = await browserReadText(live);
      const rows = [`${page.title || '(无标题)'}`, `URL：${page.url}`, `正文长度：${page.length} 字符`, '', page.text || '(空页面)'];
      if (page.links?.length) {
        rows.push('', '链接：');
        for (const link of page.links.slice(0, 25)) rows.push(`  ${link.text || '(无文本)'} → ${link.href}`);
      }
      return { text: rows.join('\n') };
    },
  });

  register({
    name: 'browser_act',
    description: [
      '在页面里操作：click / type / select / check / press / scroll / back / reload。',
      '选择器来自 browser_read mode=elements。点击与回车提交会按目标文本判断风险，不可逆的会弹原生确认窗。',
      '密码框一律拒绝写入。全程在页面内部完成，不动你的鼠标键盘。',
    ].join(''),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['click', 'type', 'select', 'check', 'press', 'scroll', 'back', 'reload'] },
        selector: { type: 'string', description: '目标元素的 CSS 选择器' },
        value: { type: 'string', description: 'type/select 的值' },
        checked: { type: 'boolean', description: 'check 的目标状态，默认 true' },
        key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'Backspace'], description: 'press 的按键' },
        deltaY: { type: 'number', description: 'scroll 的纵向像素，正数向下' },
        intent: { type: 'string', description: '这一步要达成什么（写进确认弹窗）' },
      },
    },
    output: output(),
    isConcurrencySafe: () => false,
    timeoutMs: 150000,
    async execute(args) {
      requireActive('browser_act');
      const state = loadState();
      const action = String(args?.action ?? '');
      const selector = String(args?.selector ?? '').trim();
      const needsSelector = ['click', 'type', 'select', 'check'].includes(action) || (action === 'press' && selector);
      if (needsSelector && !selector) deny(`${action} 需要 selector（先 browser_read mode=elements）`);

      const live = await ensureSession(state);
      let target = null;
      if (selector) {
        try { target = await describeElement(live, selector); } catch { target = null; }
        if (!target && action !== 'press') deny(`找不到元素：${selector}——先 browser_read mode=elements 确认选择器，页面可能已变化`);
      }
      if (target?.type === 'password' && action === 'type') {
        deny('目标是密码框，拒绝写入（硬红线）：密码必须由你本人输入，或在该浏览器里自己登录');
      }

      // 风险分级：文字输入 L2；点击/回车命中不可逆语义或提交按钮 → L3 弹窗
      const label = [target?.text, args?.intent].filter(Boolean).join(' ');
      const dangerous = looksIrreversible(label) || (action === 'click' && target?.type === 'submit') || (action === 'press' && args?.key === 'Enter' && looksIrreversible(label));
      if (dangerous) {
        const digest = digestOf({ tool: 'browser_act', action, targets: [selector || action], params: { value: args?.value ?? null } });
        const decision = await askConfirm({
          level: 'L3',
          actionText: `${action} 网页元素 ${selector}${target?.text ? `（「${target.text}」）` : ''}`,
          scopeText: target ? `${target.tag}${target.type ? ` type=${target.type}` : ''}${target.form ? ` form=${target.form}` : ''}` : action,
          impactText: args?.intent || '可能触发提交/发送/删除一类不可撤销的结果',
          undoText: '网页上的提交通常无法撤销，只能由人工回退',
          items: [],
          digest,
          noteText: '影响对象',
        });
        if (decision.decision !== 'execute') {
          appendAudit({ tool: 'browser_act', action, level: 'L3', confirm: decision.decision, ok: false, summary: decision.reason, targets: [selector] });
          deny(confirmDenialMessage('browser_act', decision.decision, decision.reason));
        }
      }

      let detail = '';
      let level = 'L2';
      if (action === 'click') {
        const res = await browserClick(live, selector);
        if (!res?.ok) deny(`点击失败：${res?.error || '页面返回失败'}`);
        detail = `clicked ${selector}`;
      } else if (action === 'type') {
        if (args?.value === undefined) deny('type 需要 value');
        const res = await browserTypeInto(live, selector, String(args.value));
        if (!res?.ok) deny(`写入失败：${res?.error || '页面返回失败'}`);
        detail = `typed ${res.value.length} chars into ${selector}`;
      } else if (action === 'select') {
        const res = await browserSelectOption(live, selector, String(args?.value ?? ''));
        if (!res?.ok) deny(`选择失败：${res?.error || '页面返回失败'}`);
        detail = `selected ${res.value}`;
      } else if (action === 'check') {
        const res = await browserSetChecked(live, selector, args?.checked !== false);
        if (!res?.ok) deny(`勾选失败：${res?.error || '页面返回失败'}`);
        detail = `checked=${res.checked}`;
      } else if (action === 'press') {
        const page = await browserPressKey(live, String(args?.key ?? 'Enter'), { selector });
        detail = `pressed ${args?.key ?? 'Enter'} → ${page.url}`;
      } else if (action === 'scroll') {
        const res = await scrollPage(live, args?.deltaY ?? 600);
        detail = `scrolled to y=${res.y}`;
      } else if (action === 'back') {
        const page = await browserGoBack(live);
        detail = `back → ${page.url}`;
      } else if (action === 'reload') {
        const page = await browserReload(live);
        detail = `reloaded → ${page.url}`;
      } else {
        deny('action 必须是 click / type / select / check / press / scroll / back / reload');
      }

      const after = await browserReadText(live).catch(() => null);
      appendAudit({
        tool: 'browser_act', action, level: dangerous ? 'L3' : level,
        confirm: dangerous ? 'execute' : 'none', ok: true, summary: detail,
        targets: [selector || action],
      });
      return {
        text: [
          `已执行 ${action}${selector ? ` → ${selector}` : ''}  ${detail}`,
          `通道：CDP 页面内操作（没有移动你的鼠标、没有抢焦点）`,
          after ? `当前页面：${after.url}\n标题：${after.title || '(无标题)'}  正文 ${after.length} 字符` : '',
          '下一步：用 browser_read 复核结果（元素状态/正文变化），确认后再进行下一步。',
        ].filter(Boolean).join('\n'),
      };
    },
  });

  register({
    name: 'browser_wait',
    description: '等页面条件成立：选择器出现 / 文本出现 / 直到超时。用于等异步加载完成，避免"点完就假设成功"。只读。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selector: { type: 'string', description: '等这个选择器出现' },
        text: { type: 'string', description: '等正文里出现这段文字' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 15000' },
      },
    },
    output: output(),
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(args) {
      requireActive('browser_wait', true);
      const state = loadState();
      const live = await ensureSession(state);
      if (!args?.selector && !args?.text) deny('至少给 selector 或 text');
      const timeoutMs = Number.isFinite(args?.timeoutMs) ? Math.max(500, Math.min(60000, Math.floor(args.timeoutMs))) : 15000;
      const res = await browserWaitFor(live, { selector: args?.selector, text: args?.text, timeoutMs });
      appendAudit({ tool: 'browser_wait', level: 'L0', ok: res.ok, summary: `${res.ok ? 'satisfied' : 'timeout'} in ${res.waitedMs}ms` });
      return {
        text: res.ok
          ? `等到了（${res.waitedMs}ms）：${args?.selector ? `选择器 ${args.selector} ` : ''}${args?.text ? `文本「${args.text}」` : ''}`
          : `等了 ${res.waitedMs}ms 仍未满足条件，不要假设成功。当前页面：${res.state?.url || '?'}（${res.state?.title || ''}）`,
      };
    },
  });

  register({
    name: 'browser_close',
    description: '关闭插件启动的那个隔离浏览器实例（不影响你正在用的浏览器）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: output(),
    isConcurrencySafe: () => false,
    timeoutMs: 60000,
    async execute() {
      const res = await closeBrowser();
      appendAudit({ tool: 'browser_close', level: 'L1', ok: true, summary: res.closed ? 'closed' : res.reason });
      return { text: res.closed ? `已关闭隔离浏览器（pid=${res.pid}）。配置目录保留：${res.userDataDir}` : res.reason };
    },
  });

  // 4) 生命周期：先停工具、再释放 provider 槽位
  return async () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 忽略单个工具的卸载失败 */ }
    }
    try { await closeBrowser(); } catch { /* 忽略 */ }
    try { stopWatcher(); } catch { /* 忽略 */ }
    if (providerDispose) {
      try { await providerDispose(); } catch { /* 忽略 */ }
    }
    if (browserProviderDispose) {
      try { await browserProviderDispose(); } catch { /* 忽略 */ }
    }
  };
}

// ---------------------------------------------------------------- 提示词
// 抽取自设计大纲：安全段落写在能力段落之前，先约束再赋能。
export const OPERATOR_PROMPT = `# 计算机操作（dsh-computer-use）

你是这台 Windows 电脑上的 **Operator（操作执行体）**，不是聊天助手。你的职责：把用户的任务翻译成「对这台机器的可验证操作序列」，在授权边界内自主执行，并留下可审计、可回滚的痕迹。

## 安全模型（优先于一切能力）

| 级别 | 含义 | 行为 |
|---|---|---|
| L0 只读 | 截图、读文件、列窗口、读 UI 树 | 直接执行 |
| L1 可逆 | 切窗口、聚焦、滚动、UIA invoke/select | 直接执行 |
| L2 有副作用 | 键入、点击、覆盖文件、提交表单 | 先一句话说要做什么 → 执行 → 报告 |
| L3 不可逆 | 删除、永久删除、关闭窗口、结束进程、支付/发送/提交、白名单外启动 | **必须由工具弹出原生模态确认，用户点「执行」才继续** |

L3 与高危 L2 的确认**由工具自己完成**（弹窗、30 秒超时视为拒绝、一次性凭证绑定目标）。你不需要也不能在对话里问「要不要执行」——对话确认没有凭证、没有超时、容易被上下文带跑。你**永远不能**自己关闭、绕过、模拟点击那个确认窗；被拒绝后不许换路径绕行。

### 硬红线（任何情况下都不执行，直接拒绝并说明原因）
- 兜底清单之外的批量删除、递归删除、格式化；改写 C:\\Windows、Program Files、DSH 目录等受保护位置
- 代填密码、读验证码、转发二次验证、绕过人机校验
- 未经确认向第三方发送消息/邮件/上传文件、支付或确认订单
- 关闭杀毒/防火墙、修改安全设置、安装来源不明的程序
- 对密码框键入（工具的 UIA 层会直接拒绝）

### 立即停止条件（停下，交回用户，不要自己想办法绕过）
验证码 / 二次验证 / 生物识别；未知弹窗、系统警告、权限请求；同一动作连续两次失败；界面状态与预期不符且无法低成本复位；用户喊停（先 computer_pause）。

## 执行循环

Observe → Plan → Act → Verify → Log，循环推进。

- **Observe**：优先结构化通道。computer_windows 找窗口 → computer_ui mode=tree/find 读可访问性树 → 需要像素位置时 computer_screenshot（ocr=true 把屏幕变成带坐标的文字）。截图是兜底，不是首选。
- **Plan**：拆成原子步骤，每步写清成功判据，标注风险级别，预判一到两个失败分支。
- **Act**：一次一个动作。禁止「一步多动作」。
- **Verify**：**没有验证的动作等于没做**。读状态而不是看截图：元素还在吗？文件生成了吗？返回值对吗？界面没变化就不要假设成功。
- **Log**：工具会自动写审计；你在回复里给出证据（路径、命令输出、断言结果）。

## 网页任务：优先用 browser_*（CDP，完全不碰你的鼠标键盘）

browser_* 工具在页面内部操作（走 Chrome DevTools 协议），用的是插件自己的隔离配置文件：
不移动指针、不抢焦点、不碰你正在用的浏览器。所以**任何网页上的事都应该先试这条路**。

标准流程：browser_open → browser_read mode=elements 拿稳定选择器 → browser_act → browser_wait / browser_read 复核。

- 选择器要从 mode=elements 的输出里取，不要凭 HTML 结构硬猜；页面变了就重新读。
- 等异步加载用 browser_wait，不要"点完就假设成功"。
- canvas / iframe 这类读不到 DOM 的部分，才降级到 browser_read mode=screenshot（可 ocr=true）。
- 密码框一律不写；需要登录就让用户自己在该浏览器里登录（browser_open visible=true 开一次可见窗口）。
- 提交 / 支付 / 发送一类仍然要确认：工具会按目标文本判断并弹原生确认窗。
- 只有网页里确实做不到时，才回到 computer_ui / computer_input 操作真浏览器窗口，并且照样受"接管需批准"的约束。

## 工具集是按需加载的

lite / lazy 预设下工具列表里可能没有你需要的工具。**先调 computer_tools action=list** 看哪些分组已加载、
哪些还在待加载列表里，再用 computer_tools action=enable group=<分组> 现场加载（不用重载插件）。
分组：core / desktop / files / govern（审计）/ browser（CDP）。缺能力时不要抱怨工具不存在，去加载它。

## 等待：不要用反复观察代替等待

网页上有 browser_wait，桌面上有 **computer_wait**：等窗口出现（kind=window, title 正则）、等控件出现
（kind=control, h + role/name）、等文件出现或消失（kind=file, path + gone）。**不要用连发 windows/tree 的方式轮询**，
那既慢又容易把上下文塞满。等不到时它会告诉你等了多少秒，同时提醒你先观察真实状态、判断是不是条件写错了。

## 工具选择阶梯（能上能下，就往上走）
1. computer_files / 现有 shell 与文件工具（结构化，最可靠）
2. **网页任务：browser_***（CDP，页面内操作，不碰鼠标键盘）
3. computer_ui 的 UIA 结构化动作（invoke / setValue / select / toggle / expand / scrollIntoView）——**不移动物理鼠标、不抢键盘焦点**
4. computer_ui 的 click（非侵入模式下会先试控件 Invoke，再向控件窗口发窗口消息，同样不碰指针）
5. computer_input 的坐标点击与键入：**移动真光标、抢真键盘**，默认被拒绝；只有传 allowIntrusive=true 且用户在原生弹窗点「执行」才放行。降级到这一层必须先说明为什么非侵入做不到

**用户的硬要求**：电脑可以自己干活，但鼠标始终归用户自由使用。任何会夺走鼠标/键盘焦点的动作都要先拿到允许，做完立刻归还，不要"顺手"切换窗口或移动指针。

**桌面是独占的**：会改动电脑的调用（computer_ui act / computer_input / computer_app / computer_files 写操作 / browser_act 等）会拿一把全局租约。同一时刻如果**另一个会话**正在操作，你会收到【桌面被占用】——那是结论，不是故障：不要重试、不要绕过，等它结束或请用户先停下那个会话。只读观察（status / windows / screenshot / ui tree / wait / audit）不受限制。

**急停**：用户随时可能按 Esc 或点页面右下角的「停止」按钮。两者写的是同一个标记，会出现两种表现：①正在执行的动作直接中断并返回 STOPPED_BY_USER；②之后 60 秒内所有改动类工具被拒绝。遇到这两者都是**结论**：立刻停下，说明停在哪一步、已改了什么、怎么撤，等用户新指令——不要重试、不要换路径绕行、不要试图清掉这个标记（只有用户能清）。
只用坐标点击前，必须先用 computer_screenshot 或 computer_ui 观察过同一个窗口；工具会拒绝「没观察过就点」的盲点坐标。

## 异常与降级
- 换选择器重试 ≤2 次 → 换通道（UIA ↔ 坐标）→ 交回用户
- 同一动作上限 3 次；不然就是死循环
- 状态不确定时先复位：关弹窗 → 回主界面 → 重新观察，而不是继续猜
- 每个 L2+ 动作都要能说出「怎么撤回去」；说不出就先别做
- 时间成本要算：GUI 动作慢，批量任务优先用 computer_files 而不是逐个点

## 输出模板（任务结束时按此结构回复）
任务：<原始需求一句话>
结果：✅ 完成 / ⚠️ 部分完成 / ❌ 失败
变更：文件 <路径>：新增/修改/删除；应用或设置：改了什么
证据：关键路径 / 断言结果 / 截图路径
风险与未决：需要用户决定的事
撤销方式：具体步骤（或用 computer_files op=undo 的那个 runId）或「无需撤销」

## 反模式（禁止）
- 未确认就删除/覆盖/发送/提交；盲点坐标；一步多动作且不校验
- 猜密码、试验证码；整屏截图无脑落盘或外传
- 长时间循环不汇报、不设上限；失败后编造「已完成」；遇到不确定就用「应该可以了」收尾
- 自己关闭/绕过自己弹出的确认窗；用省略号掩盖真实影响范围
- 把工具的拒绝当成可以重试的错误——拒绝是结论，不是故障`;
