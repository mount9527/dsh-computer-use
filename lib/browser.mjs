// 浏览器自动化（CDP）：在页面内部完成操作，不碰操作系统的鼠标键盘。
// 与 desk.ps1 的分工：desk 负责"这台电脑的桌面"，这里负责"网页内部"。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserWsUrl, candidateBrowsers, CdpConnection, launchBrowser, sleep } from './cdp.mjs';
import { desk } from './desk.mjs';
import { shotPath } from './audit.mjs';
import { dataDir } from './paths.mjs';

/** 当前进程内的浏览器会话（一个插件实例只维护一个隔离实例）。 */
let session = null;

export function currentSession() {
  return session;
}

function profileDir(state) {
  // 允许在 state.json 里换一个 profile 目录：上一个实例崩溃留下的 lockfile
  // 会被进程占着，而我们不希望在用户机器上瞎杀进程。
  const custom = state && state.browser && typeof state.browser.profileDir === 'string'
    ? state.browser.profileDir.trim()
    : '';
  return custom ? custom : join(dataDir(), 'browser-profile');
}

function resolveExe(state) {
  const configured = state.browser?.exePath;
  if (configured && configured.trim()) return configured.trim();
  const candidates = candidateBrowsers();
  if (candidates.length === 0) throw new Error('没找到 Edge / Chrome：在 state.json 的 browser.exePath 里指定可执行文件路径');
  // 优先 Edge（Windows 自带，许可最省心）
  const edge = candidates.find((c) => /msedge\.exe$/i.test(c));
  return edge || candidates[0];
}

/** 连上（必要时启动）隔离的浏览器实例。 */
export async function ensureSession(state, options = {}) {
  if (session && !session.conn.closed) {
    // 端口还活着就复用
    try {
      await fetch(`${session.httpBase}/json/version`, { signal: AbortSignal.timeout(2500) });
      return session;
    } catch {
      // 挂了，下面重启
      try { await session.conn.close(); } catch { /* 忽略 */ }
      session = null;
    }
  }

  const exe = resolveExe(state);
  const headless = options.visible === true ? false : (state.browser?.headless !== false);
  const userDataDir = profileDir(state);
  const launched = await launchBrowser({ exe, userDataDir, headless, startUrl: 'about:blank' });
  const { wsUrl, info } = await browserWsUrl(launched.httpBase);
  const conn = await CdpConnection.open(wsUrl);

  session = {
    conn,
    pid: launched.pid,
    port: launched.port,
    httpBase: launched.httpBase,
    exe,
    headless,
    userDataDir,
    browserVersion: info.Browser || '',
    page: null,
    startedAt: new Date().toISOString(),
  };
  return session;
}

async function ensurePage(current) {
  if (current.page) {
    try {
      // 页面可能被用户关掉了：试一次轻量命令确认
      await current.conn.send('Runtime.evaluate', { expression: '1', returnByValue: true }, current.page.sessionId);
      return current.page;
    } catch {
      current.page = null;
    }
  }
  const targets = await current.conn.send('Target.getTargets');
  let pageInfo = (targets.targetInfos || []).find((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
  if (!pageInfo) {
    const created = await current.conn.send('Target.createTarget', { url: 'about:blank' });
    pageInfo = { targetId: created.targetId, url: 'about:blank' };
  }
  const attached = await current.conn.send('Target.attachToTarget', { targetId: pageInfo.targetId, flatten: true });
  current.page = { targetId: pageInfo.targetId, sessionId: attached.sessionId };
  await current.conn.send('Page.enable', {}, current.page.sessionId);
  await current.conn.send('Runtime.enable', {}, current.page.sessionId);
  return current.page;
}

export async function evaluate(current, expression, { awaitPromise = false } = {}) {
  const page = await ensurePage(current);
  const res = await current.conn.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
    timeout: 20000,
  }, page.sessionId);
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || '页面脚本报错';
    throw new Error(detail);
  }
  return res.result?.value;
}

export async function navigate(current, url, { waitMs = 12000 } = {}) {
  const page = await ensurePage(current);
  const loaded = current.conn.once('Page.loadEventFired', { timeoutMs: waitMs }).catch(() => null);
  await current.conn.send('Page.navigate', { url }, page.sessionId);
  await loaded;
  await sleep(150);
  return evaluate(current, '({ title: document.title, url: location.href, readyState: document.readyState })');
}

const READ_TEXT_JS = `(() => {
  const body = document.body ? document.body.innerText : '';
  return {
    title: document.title,
    url: location.href,
    text: body.replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 20000),
    length: body.length,
    links: Array.from(document.querySelectorAll('a[href]')).slice(0, 40).map(a => ({ text: (a.innerText || '').trim().slice(0, 60), href: String(a.href).slice(0, 160) })),
  };
})()`;

const READ_ELEMENTS_JS = `(() => {
  const cssEscape = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));
  const selectorFor = (el) => {
    if (el.id) return '#' + cssEscape(el.id);
    for (const attr of ['data-testid', 'data-test', 'name', 'aria-label']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) return el.tagName.toLowerCase() + '[' + attr + '="' + cssEscape(v) + '"]';
    }
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 6) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      if (cur.id) { parts[0] = '#' + cssEscape(cur.id); break; }
      cur = parent;
      depth++;
    }
    return parts.join(' > ');
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const out = [];
  const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]');
  for (const el of nodes) {
    if (out.length >= 120) break;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    out.push({
      sel: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      text: (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
      href: el.getAttribute('href') ? String(el.getAttribute('href')).slice(0, 140) : '',
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return out;
})()`;

export async function readText(current) {
  return evaluate(current, READ_TEXT_JS);
}

export async function readElements(current) {
  const list = await evaluate(current, READ_ELEMENTS_JS);
  return Array.isArray(list) ? list : [];
}

/** 先取元素信息（供风险分级 + 给人看），再决定要不要动手。 */
export async function describeElement(current, selector) {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      text: (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      disabled: Boolean(el.disabled),
      form: el.form ? (el.form.getAttribute('action') || el.form.getAttribute('name') || '(form)') : '',
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  })()`;
  return evaluate(current, expr);
}

const CLICK_JS = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'selector not found' };
  if (el.disabled) return { ok: false, error: 'element is disabled' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { ok: true };
})()`;

const TYPE_JS = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'selector not found' };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const value = ${JSON.stringify(value)};
  if ('value' in el) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, value); else el.value = value;
  } else {
    el.textContent = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: 'value' in el ? String(el.value) : String(el.textContent) };
})()`;

const SELECT_JS = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'selector not found' };
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: String(el.value) };
})()`;

const CHECK_JS = (selector, checked) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, error: 'selector not found' };
  if (el.checked !== ${checked ? 'true' : 'false'}) el.click();
  return { ok: true, checked: Boolean(el.checked) };
})()`;

export async function click(current, selector) {
  return evaluate(current, CLICK_JS(selector));
}

export async function typeInto(current, selector, value) {
  return evaluate(current, TYPE_JS(selector, String(value)));
}

export async function selectOption(current, selector, value) {
  return evaluate(current, SELECT_JS(selector, String(value)));
}

export async function setChecked(current, selector, checked) {
  return evaluate(current, CHECK_JS(selector, Boolean(checked)));
}

/** 页面内按键：走 CDP Input.dispatchKeyEvent，发给页面而不是操作系统。 */
export async function pressKey(current, key, { selector = '' } = {}) {
  const page = await ensurePage(current);
  if (selector) await evaluate(current, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.focus(); return Boolean(el); })()`);
  const map = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  };
  const spec = map[key];
  if (!spec) throw new Error(`不支持的按键：${key}（可用：${Object.keys(map).join(' / ')}）`);
  await current.conn.send('Input.dispatchKeyEvent', { type: 'keyDown', ...spec }, page.sessionId);
  await current.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode }, page.sessionId);
  await sleep(120);
  return evaluate(current, '({ title: document.title, url: location.href })');
}

export async function goBack(current) {
  await evaluate(current, 'history.back()');
  await sleep(600);
  return evaluate(current, '({ title: document.title, url: location.href })');
}

export async function reload(current) {
  const page = await ensurePage(current);
  const loaded = current.conn.once('Page.loadEventFired', { timeoutMs: 12000 }).catch(() => null);
  await current.conn.send('Page.reload', {}, page.sessionId);
  await loaded;
  return evaluate(current, '({ title: document.title, url: location.href })');
}

export async function scrollPage(current, deltaY) {
  return evaluate(current, `(() => { window.scrollBy(0, ${Number(deltaY) || 0}); return { y: window.scrollY }; })()`);
}

/** 等一个条件：选择器出现 / 文本出现 / 网络静默（用 readyState + 稳定 DOM 近似）。 */
export async function waitFor(current, { selector = '', text = '', timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const selectorCheck = selector
    ? `Boolean(document.querySelector(${JSON.stringify(selector)}))`
    : 'true';
  const textCheck = text
    ? `(document.body ? document.body.innerText : '').includes(${JSON.stringify(text)})`
    : 'true';
  const expr = `(() => ({ sel: ${selectorCheck}, text: ${textCheck}, ready: document.readyState, url: location.href, title: document.title }))()`;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await evaluate(current, expr); } catch { /* 导航中会有瞬时报错，继续等 */ }
    if (last && last.sel && last.text) {
      return { ok: true, waitedMs: timeoutMs - (deadline - Date.now()), state: last };
    }
    await sleep(250);
  }
  return { ok: false, waitedMs: timeoutMs, state: last };
}

/** 页面截图 → PNG；需要的话再 OCR 成带坐标的文字。fullPage=true 时截整页（越过视口）。 */
export async function screenshot(current, { ocr = false, lang = '', fullPage = false } = {}) {
  const page = await ensurePage(current);
  // fullPage：先量内容高度，再让 CDP 越过视口截整页（captureBeyondViewport）
  let clip;
  if (fullPage) {
    try {
      const metrics = await current.conn.send('Page.getLayoutMetrics', {}, page.sessionId);
      const size = metrics.cssContentSize || metrics.contentSize;
      if (size && size.width && size.height) {
        clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
      }
    } catch { /* 量不到就退回视口 */ }
  }
  const shot = await current.conn.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: Boolean(clip),
    ...(clip ? { clip } : {}),
  }, page.sessionId);
  const path = shotPath('browser');
  writeFileSync(path, Buffer.from(shot.data, 'base64'));
  const info = await evaluate(current, '({ title: document.title, url: location.href, w: innerWidth, h: innerHeight })');
  let ocrResult = null;
  if (ocr) {
    const res = await desk.ocr({ path, lang, limit: 200 }, { timeoutMs: 60000 });
    if (res.ok) ocrResult = res.data;
    else ocrResult = { error: res.error || 'OCR 失败', lines: [] };
  }
  return { path, ...info, ocr: ocrResult };
}

export async function closeBrowser() {
  if (!session) return { ok: true, closed: false, reason: '没有运行中的浏览器' };
  const current = session;
  session = null;
  try { await current.conn.send('Browser.close'); } catch { /* 忽略 */ }
  try { await current.conn.close(); } catch { /* 忽略 */ }
  await sleep(300);
  return { ok: true, closed: true, pid: current.pid, userDataDir: current.userDataDir };
}

export async function sessionInfo() {
  if (!session || session.conn.closed) return null;
  let page = null;
  try { page = await evaluate(session, '({ title: document.title, url: location.href })'); } catch { /* 页面可能已关 */ }
  return {
    pid: session.pid,
    port: session.port,
    exe: session.exe,
    headless: session.headless,
    version: session.browserVersion,
    userDataDir: session.userDataDir,
    page,
  };
}
