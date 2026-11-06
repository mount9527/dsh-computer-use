// 桌面互斥：同一时刻只允许一个会话/agent 改动这台电脑。
//
// 为什么需要：插件实例是进程级共享的，两个会话可以同时调 computer_ui/computer_input，
// 结果就是抢鼠标、抢前台、互相把对方的窗口切走——而且两边的"已验证"结论都会失真。
//
// 实现：用「建目录」当原子锁（Windows 上 mkdir 是原子的，比"检查文件再创建"可靠）。
// 锁目录里放 owner.json 记录持有人、工具、时间。租约到期可被抢占，避免崩溃后永久锁死。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './paths.mjs';

const DEFAULT_TTL_MS = 120000;

const lockDir = () => join(dataDir(), 'desktop.lock');
const ownerFile = () => join(lockDir(), 'owner.json');

function readOwner() {
  try {
    return JSON.parse(readFileSync(ownerFile(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 申请租约。返回 { ok, token } 或 { ok:false, holder, ageMs, remainingMs }。
 * 同一个 owner 重复申请视为续租（不会自锁）。
 */
export function acquireLease({ owner, tool, ttlMs = DEFAULT_TTL_MS, retries = 1 }) {
  if (!owner) return { ok: false, holder: null, error: '缺少 owner 标识' };
  const path = lockDir();
  mkdirSync(dataDir(), { recursive: true });
  try {
    mkdirSync(path); // 原子：成功=拿到锁
    writeFileSync(ownerFile(), JSON.stringify({ owner, tool, at: Date.now(), pid: process.pid }), 'utf8');
    return { ok: true, token: owner, acquired: true };
  } catch (err) {
    if (err && err.code !== 'EEXIST') {
      return { ok: false, holder: null, error: `无法创建锁：${err.message}` };
    }
  }

  const info = readOwner();
  if (info && info.owner === owner) {
    // 续租：同一个会话的连续操作不该被自己挡住
    try { writeFileSync(ownerFile(), JSON.stringify({ ...info, tool, at: Date.now(), pid: process.pid }), 'utf8'); } catch { /* 忽略 */ }
    return { ok: true, token: owner, refreshed: true };
  }

  const ageMs = info && info.at ? Date.now() - Number(info.at) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(ageMs) || ageMs > ttlMs) {
    if (retries <= 0) return { ok: false, holder: info, ageMs, remainingMs: 0, error: '抢占失败' };
    // 过期（或目录在但没有合法的 owner.json）：清掉再来一次
    try { rmSync(path, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return acquireLease({ owner, tool, ttlMs, retries: retries - 1 });
  }
  return { ok: false, holder: info, ageMs, remainingMs: ttlMs - ageMs };
}

/** 释放租约。只有持有人能释放。 */
export function releaseLease(token) {
  if (!token) return false;
  const info = readOwner();
  if (!info || info.owner !== token) return false;
  try { rmSync(lockDir(), { recursive: true, force: true }); } catch { return false; }
  return true;
}

/** 当前锁的持有人信息（给 computer_status / 设置页展示）。 */
export function lockInfo(ttlMs = DEFAULT_TTL_MS) {
  if (!existsSync(lockDir())) return { held: false };
  const info = readOwner();
  if (!info) return { held: true, stale: true };
  const ageMs = Date.now() - Number(info.at || 0);
  return {
    held: true,
    owner: String(info.owner ?? ''),
    tool: String(info.tool ?? ''),
    ageMs,
    remainingMs: Math.max(0, ttlMs - ageMs),
    stale: ageMs > ttlMs,
  };
}

/** 清理过期锁（插件启动时调一次，避免上次崩溃留下的死锁）。 */
export function clearStaleLock(ttlMs = DEFAULT_TTL_MS) {
  const info = lockInfo(ttlMs);
  if (!info.held) return false;
  if (!info.stale && info.owner) return false;
  try { rmSync(lockDir(), { recursive: true, force: true }); return true; } catch { return false; }
}
