// 冒烟测试：错误信息中文化（不依赖 DSH 宿主，也不真的失败任何桌面操作）
import { localizeDeskFailure, describeFsError, describeBrowserError } from 'file:///E:/ruanjianxiazai/deepseek/work/dsh-computer-use/lib/messages.mjs';

const hasChinese = (s) => /[\u4e00-\u9fa5]/.test(String(s ?? ''));
const hasAsciiError = (s) => /\b(cannot|does not support|failed|failed to|Denied|not found)\b/i.test(String(s ?? ''));

let bad = 0;
function check(name, ok, detail = '') {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ->  ${detail}` : ''}`);
}

// 1) 带错误码的失败：主句必须中文，技术细节保留
const r1 = localizeDeskFailure({
  ok: false,
  code: 'ELEMENT_NO_INVOKE',
  error: "element does not support Invoke: Specified method is not supported.",
  hints: ['try action=click instead'],
});
check('错误码翻译成中文', hasChinese(r1.error) && !hasAsciiError(r1.error.split('\n')[0]), r1.error.split('\n')[0]);
check('保留技术细节', r1.error.includes('Specified method is not supported'));
check('英文 hint 也翻译了', r1.error.includes('换成 computer_ui action=click'), r1.error.split('\n').filter((l) => l.startsWith('提示'))[0] || '');

// 2) 每个错误码都要有中文映射
const codes = ['UIA_TREE_UNREADABLE', 'SPAWN_FAILED', 'ELEMENT_NO_SETVALUE', 'ELEMENT_NO_SELECT',
  'ELEMENT_NO_TOGGLE', 'ELEMENT_NO_EXPAND', 'ELEMENT_NO_COLLAPSE', 'ELEMENT_NO_SCROLL',
  'ELEMENT_NOT_FOUND', 'CLICK_BLOCKED', 'OCR_FAILED', 'INTEROP_INIT_FAILED', 'STALE_HANDLE', 'BAD_ARG'];
for (const code of codes) {
  const r = localizeDeskFailure({ ok: false, code, error: 'whatever english: detail' });
  check(`码 ${code} 有中文说明`, hasChinese(r.error), r.error.split('（')[0]);
}

// 3) 没有码时也不能把英文当主句
const r2 = localizeDeskFailure({ ok: false, error: 'window handle is invalid or closed: 0x1234' });
check('无码时的兜底也是中文', r2.error.startsWith('桌面操作失败：'), r2.error);

// 4) 成功结果原样返回（不能被改写）
const okResult = { ok: true, data: { x: 1 } };
check('成功结果不动', localizeDeskFailure(okResult) === okResult);

// 5) fs errno
for (const [code, expect] of [['ENOENT', '不存在'], ['EPERM', '权限'], ['EBUSY', '占用'], ['ENOSPC', '空间']]) {
  const zh = describeFsError({ code }, 'C:\\some\\path');
  check(`fs ${code} 翻成中文`, hasChinese(zh) && zh.includes(expect), zh);
}

// 6) 浏览器异常
for (const [raw, expect] of [
  ['Target closed', '关闭'],
  ['Execution context was destroyed', '跳转'],
  ['Timeout 15000ms exceeded', '超时'],
  ['net::ERR_CONNECTION_REFUSED at https://x', '网络'],
]) {
  const zh = describeBrowserError(new Error(raw));
  check(`浏览器「${raw}」翻成中文`, hasChinese(zh) && zh.includes(expect), zh);
}
check('已经是中文的原样保留', describeBrowserError(new Error('没找到 Edge / Chrome：在 state.json 里指定')) === '没找到 Edge / Chrome：在 state.json 里指定');

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
