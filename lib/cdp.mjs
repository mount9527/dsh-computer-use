// 最小 Chrome DevTools Protocol 客户端：只用 Node 内置能力（global WebSocket / fetch）。
// 为什么走 CDP 而不是模拟鼠标：CDP 在页面内部完成任务，不碰操作系统层面的指针与焦点，
// 所以用户能同时用自己的鼠标；而且读的是 DOM，比截图 OCR 稳得多。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 一条 CDP 连接。响应按 id 配对，事件按 method 分发。 */
export class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  static async open(wsUrl, { timeoutMs = 15000 } = {}) {
    const conn = new CdpConnection(wsUrl);
    await conn.#connect(timeoutMs);
    return conn;
  }

  #connect(timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this.ws?.close(); } catch { /* 忽略 */ }
        reject(new Error(`CDP connect timeout after ${timeoutMs} ms: ${this.wsUrl}`));
      }, timeoutMs);

      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      this.ws = ws;

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CDP socket error: ${this.wsUrl}`));
      });
      ws.addEventListener('close', () => {
        this.closed = true;
        for (const [, entry] of this.pending) {
          entry.reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
      });
      ws.addEventListener('message', (event) => {
        let msg;
        try { msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const entry = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`${msg.error.message || 'CDP error'}${msg.error.code ? ` (code ${msg.error.code})` : ''}`));
          else entry.resolve(msg.result ?? {});
          return;
        }
        if (msg.method) {
          const handlers = this.listeners.get(msg.method);
          if (handlers) for (const handler of handlers) { try { handler(msg.params, msg.sessionId); } catch { /* 忽略 */ } }
        }
      });
    });
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('CDP connection is closed'));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out after 20s`));
        }
      }, 20000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => { this.listeners.get(method)?.delete(handler); };
  }

  once(method, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`CDP event ${method} not received within ${timeoutMs} ms`));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  async close() {
    this.closed = true;
    try { this.ws?.close(); } catch { /* 忽略 */ }
  }
}

/** 候选浏览器可执行文件（用户可用 state.json 覆盖）。 */
export function candidateBrowsers() {
  const candidates = [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:\\Users\\default', 'AppData', 'Local');
  for (const exe of [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]) {
    if (existsSync(exe)) candidates.push(exe);
  }
  return candidates;
}

/**
 * 启动一个**独立配置目录**的浏览器实例（不碰用户正在用的那个），
 * 用 --remote-debugging-port=0 让浏览器自己挑端口，再从 DevToolsActivePort 里读回来。
 */
export async function launchBrowser({
  exe, userDataDir, headless = false, startUrl = 'about:blank', extraArgs = [], timeoutMs = 25000,
}) {
  mkdirSync(dirname(userDataDir), { recursive: true });
  const portFile = join(userDataDir, 'DevToolsActivePort');
  try { rmSync(portFile, { force: true }); } catch { /* 忽略 */ }

  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-features=Translate,msEdgeIdentityPrompt',
    '--window-size=1280,900',
    startUrl,
  ];
  if (headless) args.unshift('--headless=new');
  args.push(...extraArgs);

  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (!existsSync(portFile)) {
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`browser exited immediately (code ${child.exitCode}); check exe permissions or profile dir`);
      }
      continue;
    }
    let text = '';
    try { text = readFileSync(portFile, 'utf8'); } catch { continue; }
    const [portLine, pathLine] = text.split(/\r?\n/);
    const port = Number.parseInt(portLine, 10);
    if (!Number.isFinite(port) || port <= 0) continue;
    const wsPath = (pathLine || '').trim();
    return {
      ok: true,
      pid: child.pid,
      port,
      userDataDir,
      headless,
      wsPath,
      httpBase: `http://127.0.0.1:${port}`,
    };
  }
  try { child.kill(); } catch { /* 忽略 */ }
  throw new Error(`browser did not expose a DevTools port within ${timeoutMs} ms (profile: ${userDataDir})`);
}

/** 读 /json/version，拿浏览器级 WebSocket 地址。 */
export async function browserWsUrl(httpBase) {
  const res = await fetch(`${httpBase}/json/version`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`/json/version returned ${res.status}`);
  const info = await res.json();
  if (!info.webSocketDebuggerUrl) throw new Error('/json/version has no webSocketDebuggerUrl');
  return { wsUrl: info.webSocketDebuggerUrl, info };
}

export { sleep };
