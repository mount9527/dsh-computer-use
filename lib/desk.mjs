// desk.ps1 的 Node 侧桥接：一个动词 = 一次子进程。
// 子进程由宿主进程直接派生，因此是正常完整性级别（不受 pwsh 工具的沙箱限制），
// 这是能真正注入鼠标键盘、弹出原生模态确认的前提。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDir } from './paths.mjs';
import { activityFile, stopFile } from './stop.mjs';
import { localizeDeskFailure } from './messages.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const packageRoot = dirname(here);
export const scriptPath = join(packageRoot, 'scripts', 'desk.ps1');

function powershellPath() {
  const sys = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const full = join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell.exe';
}

function prepare() {
  const dir = runDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 运行一个动词。永远返回结构化结果，不抛异常。
 * @returns {Promise<{ok:boolean, data:object, error?:string, hints?:string[], stderr?:string}>}
 */
export async function runVerb(verb, spec = {}, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!existsSync(scriptPath)) {
    return { ok: false, data: {}, error: `找不到桌面执行脚本（desk.ps1）：${scriptPath}` };
  }

  const dir = prepare();
  const id = randomUUID();
  const inFile = join(dir, `in-${id}.json`);
  const outFile = join(dir, `out-${id}.json`);
  let stderr = '';

  const cleanup = () => {
    for (const f of [inFile, outFile]) {
      try { rmSync(f, { force: true }); } catch { /* 忽略 */ }
    }
  };

  try {
    writeFileSync(inFile, JSON.stringify(spec ?? {}), 'utf8');
  } catch (err) {
    return { ok: false, data: {}, error: `无法写入执行参数文件：${err.message}` };
  }

  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', scriptPath,
    '-Verb', verb,
    '-InFile', inFile,
    '-OutFile', outFile,
    '-Root', packageRoot,
    // 子进程也能看到急停标记，所以正在跑的长循环也能被打断；
    // 同时由它刷新活动戳，让 Esc 在这一个长操作期间保持"武装"
    '-StopFile', options.stopFile ?? stopFile(),
    '-ActivityFile', options.activityFile ?? activityFile(),
  ];

  const result = await new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(powershellPath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      resolve({ spawnError: err.message });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 忽略 */ }
      resolve({ timedOut: true });
    }, timeoutMs);

    child.stderr?.on('data', (chunk) => {
      if (stderr.length > 8000) return;
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ spawnError: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code });
    });
  });

  try {
    if (result.spawnError) {
      return { ok: false, data: {}, error: `无法启动 PowerShell 执行体：${result.spawnError}`, stderr };
    }
    if (result.timedOut) {
      return { ok: false, data: {}, error: `桌面操作等待超时（${timeoutMs} 毫秒），确认窗或目标界面可能已关闭`, stderr };
    }
    if (!existsSync(outFile)) {
      return { ok: false, data: {}, error: '桌面执行体没有产出结果（它崩溃了，或被安全软件拦下）', stderr: stderr.trim().slice(-1200) };
    }
    const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, data: {}, error: '桌面执行体的输出无法解析（不是 JSON 对象）', stderr };
    }
    const normalized = {
      ok: Boolean(parsed.ok),
      data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
      error: parsed.error,
      code: typeof parsed.code === 'string' ? parsed.code : undefined,
      hints: Array.isArray(parsed.hints) ? parsed.hints : undefined,
      stderr: parsed.ok ? undefined : stderr.trim().slice(-1200) || undefined,
    };
    // 一处本地化：所有经 desk 的失败信息都在这里变成中文，工具层不用各写一遍
    return localizeDeskFailure(normalized);
  } catch (err) {
    return { ok: false, data: {}, error: `桌面执行体的输出读取失败：${err.message}`, stderr: stderr.trim().slice(-1200) };
  } finally {
    cleanup();
  }
}

export const desk = {
  probe: (options) => runVerb('probe', {}, options),
  windows: (spec, options) => runVerb('windows', spec, options),
  shot: (spec, options) => runVerb('shot', spec, options),
  ocr: (spec, options) => runVerb('ocr', spec, options),
  uia: (spec, options) => runVerb('uia', spec, options),
  input: (spec, options) => runVerb('input', spec, options),
  activate: (spec, options) => runVerb('activate', spec, options),
  confirm: (spec, options) => runVerb('confirm', spec, options),
};
