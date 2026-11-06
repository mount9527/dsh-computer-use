// 单元测试：stop.mjs 的判定规则（不需要真实按键，也不需要真实数据目录）
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cu-stoptest-'));
process.env.DSH_HOME = home;
const dataDir = join(home, 'computer-use');
mkdirSync(dataDir, { recursive: true });

const stop = await import('file:///E:/ruanjianxiazai/deepseek/work/dsh-computer-use/lib/stop.mjs');
const file = join(dataDir, 'stop.json');
const state = { stopHoldMs: 60000 };

const put = (marker) => writeFileSync(file, JSON.stringify(marker), 'utf8');

function check(name, marker, expected) {
  if (marker === null) rmSync(file, { force: true });
  else put(marker);
  const r = stop.readStop(state);
  const ok = expected === 'null'
    ? r === null
    : Boolean(r) && r.armed === expected.armed && Math.abs(r.remainingMs - expected.remainingMs) < 2000;
  const shown = r === null
    ? 'null（不拦截）'
    : `armed=${r.armed} 剩余=${Math.round(r.remainingMs / 1000)}s source=${r.source}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ->  ${shown}`);
  return ok;
}

const now = Date.now();
const results = [
  check('没有标记', null, 'null'),
  check('页面按钮点击', { at: now, source: 'button', armed: true }, { armed: true, remainingMs: 60000 }),
  check('任务进行中按 Esc', { at: now, source: 'esc', armed: true }, { armed: true, remainingMs: 60000 }),
  check('空闲时按 Esc（也保持 60 秒）', { at: now, source: 'esc', armed: false }, { armed: false, remainingMs: 60000 }),
  check('20 秒前的空闲 Esc（人的往返延迟内）', { at: now - 20000, source: 'esc', armed: false }, { armed: false, remainingMs: 40000 }),
  check('13 秒前的空闲 Esc（上一版就是这里漏掉的）', { at: now - 13000, source: 'esc', armed: false }, { armed: false, remainingMs: 47000 }),
  check('59 秒前的 Esc → 仍在窗口内', { at: now - 59000, source: 'esc', armed: true }, { armed: true, remainingMs: 1000 }),
  check('61 秒前的 Esc → 已过期', { at: now - 61000, source: 'esc', armed: true }, 'null'),
  check('缺 armed 字段的旧标记 → 当 armed', { at: now, source: 'legacy' }, { armed: true, remainingMs: 60000 }),
];

rmSync(home, { recursive: true, force: true });
const failed = results.filter((x) => !x).length;
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
