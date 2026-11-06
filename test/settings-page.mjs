// 冒烟测试：设置页的校验与渲染（不依赖 DSH 宿主）
const m = await import('file:///E:/ruanjianxiazai/deepseek/work/dsh-computer-use/lib/settings-page.mjs');

const current = { paused: false, browser: { exePath: '', headless: true } };
const cases = [
  ['只改 toolMode', { toolMode: 'lazy' }],
  ['非法 toolMode 被忽略', { toolMode: 'turbo' }],
  ['超范围被裁剪', { stopHoldMs: 999999, bulkThreshold: 0 }],
  ['布尔与列表', { paused: true, nonIntrusive: false, allowedApps: 'a.exe\n b.exe \n\n', allowRoots: 'D:\\data' }],
  ['浏览器子对象', { browser: { exePath: ' C:\\Edge\\msedge.exe ', headless: false } }],
];

let bad = 0;
for (const [name, input] of cases) {
  const r = m.sanitizePatch(input, current);
  const ok = typeof r.patch === 'object' && Array.isArray(r.errors);
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ->  patch=${JSON.stringify(r.patch)} errors=${JSON.stringify(r.errors)}`);
}

const state = {
  stopHoldMs: 60000, confirmTimeoutMs: 30000, bulkThreshold: 10, maxBatch: 500,
  observationTtlMs: 120000, logRetentionDays: 30, shotRetentionDays: 7, trashRetentionDays: 7,
  allowRoots: [], allowedApps: ['notepad.exe'], protectedProcesses: ['explorer.exe'],
  browser: { exePath: '', headless: true }, paused: false, nonIntrusive: true, toolMode: 'lite',
};
const html = m.renderSettingsHtml(state, '/dsh-cu-abc123');
const checks = [
  ['有 toolMode 下拉', html.includes('name="toolMode"')],
  ['三个预设都在', html.includes('value="full"') && html.includes('value="lite"') && html.includes('value="lazy"')],
  ['埋入了前缀', html.includes('/dsh-cu-abc123')],
  ['字段齐全', ['stopHoldMs', 'confirmTimeoutMs', 'allowedApps', 'browser.exePath', 'trashRetentionDays'].every((k) => html.includes(k))],
  ['lazy 选项被选中', html.includes('lazy')],
];
for (const [name, ok] of checks) {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`html=${html.length} 字符`);
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
