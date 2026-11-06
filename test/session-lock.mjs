// 单元测试：桌面互斥租约（mkdir 原子锁 + 过期抢占 + 自续租 + 释放）
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cu-locktest-'));
process.env.DSH_HOME = home;
const dataDir = join(home, 'computer-use');
mkdirSync(dataDir, { recursive: true });

const lock = await import('file:///E:/ruanjianxiazai/deepseek/work/dsh-computer-use/lib/session-lock.mjs');
const lockPath = join(dataDir, 'desktop.lock');

let bad = 0;
function check(name, ok, detail = '') {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ->  ${detail}` : ''}`);
}

// 1) 空闲时谁都能拿到
const a = lock.acquireLease({ owner: 'agent-A', tool: 'computer_ui' });
check('第一个会话拿到租约', a.ok === true);

// 2) 另一个会话被挡
const b = lock.acquireLease({ owner: 'agent-B', tool: 'computer_input' });
check('第二个会话被挡（说明原因）', b.ok === false && b.holder?.owner === 'agent-A', `holder=${b.holder?.owner} 剩余=${Math.round((b.remainingMs || 0) / 1000)}s`);

// 3) 同一会话续租，不自锁
const a2 = lock.acquireLease({ owner: 'agent-A', tool: 'computer_app' });
check('同一会话续租不自锁', a2.ok === true && a2.refreshed === true);

// 4) 非持有人不能释放
check('非持有人释放无效', lock.releaseLease('agent-B') === false);
check('释放后仍由 A 持有', lock.lockInfo().owner === 'agent-A');

// 5) 持有人释放
check('持有人释放成功', lock.releaseLease('agent-A') === true);
check('释放后锁不存在', lock.lockInfo().held === false);

// 6) 过期锁可被抢占
mkdirSync(lockPath, { recursive: true });
const stale = { owner: 'agent-ghost', tool: 'computer_input', at: Date.now() - 10 * 60 * 1000 };
writeFileSync(join(lockPath, 'owner.json'), JSON.stringify(stale), 'utf8');
const c = lock.acquireLease({ owner: 'agent-C', tool: 'computer_ui' });
check('过期锁被抢占', c.ok === true, `新持有人=${lock.lockInfo().owner}`);
lock.releaseLease('agent-C');

// 7) 目录存在但 owner.json 损坏 → 视为过期
mkdirSync(lockPath, { recursive: true });
writeFileSync(join(lockPath, 'owner.json'), '{not json', 'utf8');
const d = lock.acquireLease({ owner: 'agent-D', tool: 'computer_ui' });
check('损坏的锁可被接管', d.ok === true);
lock.releaseLease('agent-D');

// 8) 目录在但没有 owner.json（创建过程中崩溃）→ 可接管
mkdirSync(lockPath, { recursive: true });
const e = lock.acquireLease({ owner: 'agent-E', tool: 'computer_ui' });
check('空锁目录可被接管', e.ok === true);
check('owner.json 已写入', JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).owner === 'agent-E');
lock.releaseLease('agent-E');

// 9) clearStaleLock 只清过期/无主的
mkdirSync(lockPath, { recursive: true });
writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ owner: 'agent-live', tool: 'computer_ui', at: Date.now() }), 'utf8');
check('活跃锁不会被 clearStaleLock 清掉', lock.clearStaleLock() === false && lock.lockInfo().held === true);
rmSync(lockPath, { recursive: true, force: true });

rmSync(home, { recursive: true, force: true });
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
