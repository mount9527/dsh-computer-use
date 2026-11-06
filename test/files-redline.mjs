// 单元测试：文件红线的作用方向
// 规则：红线挡"会被改写的位置"，不挡只读来源。否则插件自己存在 %DSH_HOME% 下的截图都导不出来。
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'cu-redline-'));
process.env.DSH_HOME = join(home, 'dshhome');
const work = join(home, 'work');
mkdirSync(work, { recursive: true });
mkdirSync(process.env.DSH_HOME, { recursive: true });

const files = await import('file:///E:/ruanjianxiazai/deepseek/work/dsh-computer-use/lib/files.mjs');

const srcInsideDsh = join(process.env.DSH_HOME, 'computer-use', 'shots', 'a.png');
mkdirSync(join(process.env.DSH_HOME, 'computer-use', 'shots'), { recursive: true });
writeFileSync(srcInsideDsh, 'png', 'utf8');

const srcInWork = join(work, 'note.txt');
writeFileSync(srcInWork, 'hello', 'utf8');

const outDir = join(home, 'out');
mkdirSync(outDir, { recursive: true });

let bad = 0;
function check(name, plan, expectOk) {
  const okNow = plan.problems.length === 0;
  const pass = okNow === expectOk;
  if (!pass) bad += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  ->  ${okNow ? '允许' : '拒绝'}`);
  if (!okNow) plan.problems.forEach((p) => console.log(`        理由：${p}`));
}

// 1) copy 从 .dsh 读出来 → 应当允许
check('copy 从 %DSH_HOME% 读出来', files.planOperation({
  op: 'copy', sources: [srcInsideDsh], target: outDir,
}), true);

// 2) copy 写进 .dsh → 应当拒绝
check('copy 写进 %DSH_HOME%', files.planOperation({
  op: 'copy', sources: [srcInWork], target: join(process.env.DSH_HOME, 'x.txt'),
}), false);

// 3) delete .dsh 里的文件 → 应当拒绝
check('delete %DSH_HOME% 里的文件', files.planOperation({
  op: 'delete', sources: [srcInsideDsh],
}), false);

// 4) move 把 .dsh 文件搬走 → 应当拒绝（会从原位置拿走）
check('move 从 %DSH_HOME% 搬走', files.planOperation({
  op: 'move', sources: [srcInsideDsh], target: outDir,
}), false);

// 5) 普通目录内 copy → 允许
check('普通 copy', files.planOperation({
  op: 'copy', sources: [srcInWork], target: join(outDir, 'note-copy.txt'),
}), true);

// 6) 系统目录仍然是硬红线（写）
check('copy 到 C:\\Windows', files.planOperation({
  op: 'copy', sources: [srcInWork], target: 'C:\\Windows\\x.txt',
}), false);

rmSync(home, { recursive: true, force: true });
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
