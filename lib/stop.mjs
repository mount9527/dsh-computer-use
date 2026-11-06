// 急停：Esc 与网页上的停止按钮共用同一条通道。
// 两种触发都只做一件事——写一个停止标记；插件入口和 desk.ps1 的长循环都会读它，
// 所以它打断的是"正在做的事"，而不只是挡住"下一件事"。
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './paths.mjs';

const DEFAULT_HOLD_MS = 60000;

export const stopFile = () => join(dataDir(), 'stop.json');
export const activityFile = () => join(dataDir(), 'activity.stamp');
export const lastEscFile = () => join(dataDir(), 'last-esc.json');
export const heartbeatFile = () => join(dataDir(), 'stop-watch.heartbeat');
export const watchLogFile = () => join(dataDir(), 'stop-watch.log');

function powershellPath() {
  const sys = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const full = join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return existsSync(full) ? full : 'powershell.exe';
}

export function watchScriptPath() {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'scripts', 'stop-watch.ps1');
}

function readMsFile(path) {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** 记录"插件刚刚做过事"。长操作期间 desk.ps1 也会刷新它。 */
export function markActivity() {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(activityFile(), String(Date.now()), 'utf8');
  } catch { /* 忽略 */ }
}

/**
 * 读停止标记。**任何一次 Esc / 按钮点击都当停止，保持同一个时长**（stopHoldMs，默认 60 秒）。
 *
 * 为什么不区分"空闲时按的 Esc"：实测从用户按下到 agent 发起下一次工具调用要 10–30 秒，
 * 任何比这更短的窗口都会让用户觉得"按了没反应"。代价是随手按 Esc 关对话框也会把下一
 * 个任务挡最多 60 秒，但页面按钮上有「继续」可以立刻解除，消息里也会说清楚。
 * `armed` 只作为诊断信息保留（记录按下时插件是否正在做事）。
 */
export function readStop(state) {
  if (!existsSync(stopFile())) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(stopFile(), 'utf8')); } catch { return null; }
  const at = Number(raw?.at) || 0;
  if (!at) return null;
  const armed = !(raw && raw.armed === false);
  const holdMs = Number(state?.stopHoldMs) > 0 ? Number(state.stopHoldMs) : DEFAULT_HOLD_MS;
  const age = Date.now() - at;
  if (age > holdMs) return null;
  return { at, age, armed, source: String(raw?.source ?? 'unknown'), remainingMs: holdMs - age };
}

export function requestStop(source = 'unknown', armed = true) {
  mkdirSync(dataDir(), { recursive: true });
  const payload = { at: Date.now(), source, armed: Boolean(armed), pid: process.pid };
  writeFileSync(stopFile(), JSON.stringify(payload), 'utf8');
  return payload;
}

export function clearStop() {
  try { rmSync(stopFile(), { force: true }); } catch { /* 忽略 */ }
}

let watcher = null;

/**
 * 起常驻 Esc 监听（只观察，不吞按键）。幂等；进程死掉后再次调用会重新拉起。
 */
export function startWatcher() {
  if (watcher && watcher.exitCode === null) return watcher;
  if (process.platform !== 'win32') return null;
  try {
    mkdirSync(dataDir(), { recursive: true });
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', watchScriptPath(),
      '-StopFile', stopFile(),
      '-ActivityFile', activityFile(),
      '-LastEscFile', lastEscFile(),
      '-HeartbeatFile', heartbeatFile(),
      '-LogFile', watchLogFile(),
    ];
    // 捕获 stderr 到日志：监听进程以前悄悄死掉过一次，没有任何证据
    let stderrFd = null;
    try { stderrFd = openSync(watchLogFile(), 'a'); } catch { stderrFd = null; }
    watcher = spawn(powershellPath(), args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', stderrFd === null ? 'ignore' : stderrFd],
    });
    if (stderrFd !== null) { try { closeSync(stderrFd); } catch { /* 子进程已复制句柄 */ } }
    watcher.unref();
    watcher.on('exit', () => { watcher = null; });
    watcher.on('error', () => { watcher = null; });
    return watcher;
  } catch {
    watcher = null;
    return null;
  }
}

export function stopWatcher() {
  if (!watcher) return;
  try { watcher.kill(); } catch { /* 忽略 */ }
  watcher = null;
}

/** 让 /status 与 computer_status 能如实报告监听进程、心跳和最近一次 Esc。 */
export function watcherInfo() {
  const beat = readMsFile(heartbeatFile());
  const lastEsc = (() => {
    try { return JSON.parse(readFileSync(lastEscFile(), 'utf8')); } catch { return null; }
  })();
  const running = Boolean(watcher && watcher.exitCode === null);
  return {
    running,
    pid: watcher && watcher.pid ? watcher.pid : 0,
    heartbeatAgeMs: beat ? Date.now() - beat : 0,
    lastEscAt: lastEsc && lastEsc.at ? Number(lastEsc.at) : 0,
    lastEscSource: lastEsc && lastEsc.source ? String(lastEsc.source) : '',
    lastEscArmed: lastEsc ? lastEsc.armed !== false : false,
  };
}
