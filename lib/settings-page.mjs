// 设置页：宿主侧渲染的一张自包含 HTML（无外部依赖、无构建步骤）。
// 从页面里的「⚙ 设置」浮层打开；保存走同一个路由前缀下的 POST /settings。

const NUMERIC_RULES = [
  ['confirmTimeoutMs', 5000, 300000],
  ['stopHoldMs', 1000, 600000],
  ['bulkThreshold', 1, 1000],
  ['observationTtlMs', 5000, 600000],
  ['maxBatch', 1, 5000],
  ['logRetentionDays', 1, 3650],
  ['shotRetentionDays', 1, 3650],
  ['trashRetentionDays', 1, 3650],
];

const LIST_RULES = ['allowedApps', 'protectedProcesses', 'allowRoots'];

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 校验并裁剪一份设置补丁。返回 { patch, errors }。 */
export function sanitizePatch(input, current) {
  const patch = {};
  const errors = [];
  if (!input || typeof input !== 'object') return { patch, errors: ['请求体不是对象'] };

  if (typeof input.toolMode === 'string' && ['full', 'lite', 'lazy'].includes(input.toolMode)) {
    patch.toolMode = input.toolMode;
  }
  for (const key of ['paused', 'nonIntrusive']) {
    if (typeof input[key] === 'boolean') patch[key] = input[key];
  }
  if (input.browser && typeof input.browser === 'object') {
    const browser = { ...(current.browser ?? {}) };
    if (typeof input.browser.exePath === 'string') browser.exePath = input.browser.exePath.trim();
    if (typeof input.browser.headless === 'boolean') browser.headless = input.browser.headless;
    if (typeof input.browser.profileDir === 'string') browser.profileDir = input.browser.profileDir.trim();
    patch.browser = browser;
  }
  for (const [key, min, max] of NUMERIC_RULES) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    const n = Number(input[key]);
    if (!Number.isFinite(n)) { errors.push(`${key} 不是数字`); continue; }
    const clamped = Math.min(max, Math.max(min, Math.round(n)));
    if (clamped !== Math.round(n)) errors.push(`${key} 超出范围，已裁剪到 ${clamped}`);
    patch[key] = clamped;
  }
  for (const key of LIST_RULES) {
    if (typeof input[key] !== 'string') continue;
    patch[key] = input[key].split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  // 红线不可通过设置页关闭
  if (patch.nonIntrusive === false) {
    // 允许，但只影响"是否默认拒绝真键鼠"；接管仍然要逐次弹窗批准
  }
  if (patch.paused === false && current.paused === true) {
    // 用户在设置页里主动解除暂停：这是用户动作，允许
  }
  if (patch.confirmTimeoutMs !== undefined && patch.confirmTimeoutMs < 5000) {
    errors.push('确认超时不能短于 5 秒');
  }
  return { patch, errors };
}

function field(name, label, value, hint, attrs = '') {
  return `<label class="row"><span class="k">${esc(label)}</span>
    <input name="${esc(name)}" value="${esc(value)}" ${attrs}/>
    ${hint ? `<em>${esc(hint)}</em>` : ''}</label>`;
}

function area(name, label, list, hint) {
  return `<label class="row"><span class="k">${esc(label)}</span>
    <textarea name="${esc(name)}" rows="4" spellcheck="false">${esc((list ?? []).join('\n'))}</textarea>
    ${hint ? `<em>${esc(hint)}</em>` : ''}</label>`;
}

function toggle(name, label, checked, hint) {
  return `<label class="row chk"><span class="k">${esc(label)}</span>
    <input type="checkbox" name="${esc(name)}" ${checked ? 'checked' : ''}/>
    ${hint ? `<em>${esc(hint)}</em>` : ''}</label>`;
}

export function renderSettingsHtml(state, prefix, options = {}) {
  const p = esc(prefix);
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>电脑操控设置 · dsh-computer-use</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:22px 24px 90px;font:13px/1.6 "Microsoft YaHei UI","Segoe UI",sans-serif;
background:#f6f7f9;color:#1d2531}
@media (prefers-color-scheme:dark){body{background:#15171c;color:#e6e8ee}
.card{background:#1d2027!important;border-color:#2b3040!important}
input,textarea,select{background:#12141a!important;color:#e6e8ee!important;border-color:#333a4b!important}
em{color:#98a0b3!important}.btn{background:#2a3040!important;color:#e6e8ee!important;border-color:#3a4356!important}}
h1{font-size:16px;margin:0 0 4px}
.sub{color:#6b7280;margin:0 0 18px;font-size:12px}
.card{background:#fff;border:1px solid #e3e6ec;border-radius:10px;padding:14px 16px;margin:0 0 14px}
.card h2{font-size:13px;margin:0 0 10px;color:inherit;opacity:.82;font-weight:700;letter-spacing:.02em}
.row{display:grid;grid-template-columns:190px 1fr;gap:10px;align-items:center;margin:0 0 10px}
.row.chk{grid-template-columns:190px auto 1fr}
.row .k{font-weight:600;color:#43506b}
input,textarea,select{width:100%;padding:6px 9px;border:1px solid #d8dce4;border-radius:7px;
font:12px/1.5 "Consolas","Microsoft YaHei UI",monospace;background:#fff;color:#1d2531}
textarea{resize:vertical}
em{grid-column:2;font-style:normal;color:#7a8398;font-size:11.5px}
.bar{position:fixed;left:0;right:0;bottom:0;display:flex;gap:10px;align-items:center;
padding:12px 24px;background:rgba(246,247,249,.94);border-top:1px solid #e3e6ec;backdrop-filter:blur(6px)}
@media (prefers-color-scheme:dark){.bar{background:rgba(21,23,28,.94);border-color:#2b3040}}
.btn{padding:7px 16px;border-radius:8px;border:1px solid #d3d8e2;background:#fff;color:#1d2531;
font:13px "Microsoft YaHei UI",sans-serif;cursor:pointer}
.btn.primary{background:#2f6bff;border-color:#2f6bff;color:#fff;font-weight:600}
.btn:disabled{opacity:.5;cursor:default}
#msg{margin-left:auto;font-size:12px;color:#7a8398}
#msg.ok{color:#178a4c}#msg.err{color:#c22b2b}
.stat{font:12px/1.7 "Consolas",monospace;color:#5b6577;white-space:pre-wrap}
/* 整页截图 / iframe 嵌入模式：固定底栏会盖住中间内容，这里直接去掉 */
body.embed{padding-bottom:22px}
body.embed .bar{display:none}
</style></head>
<body class="${options.embed ? 'embed' : ''}">
<h1>电脑操控 · 设置</h1>
<p class="sub">保存后立即生效（不需要重启）。带 <b>⚠</b> 的项属于安全边界，改之前想清楚。</p>

<div class="card"><h2>运行状态</h2><div class="stat" id="stat">读取中…</div></div>

<form id="f">
  <div class="card"><h2>总开关</h2>
    ${toggle('nonIntrusive', '非侵入模式', state.nonIntrusive !== false, '开：不移动你的鼠标、不抢焦点；关：真键鼠动作仍要逐次弹窗批准')}
    ${toggle('paused', '允许执行（取消勾选=暂停）', !state.paused, '暂停后只读工具仍可用，一切改动类动作被拒')}
  </div>

  <div class="card"><h2>工具集</h2>
    <label class="row"><span class="k">预设</span>
      <select name="toolMode">
        <option value="full">full —— 全部 19 个工具都注册</option>
        <option value="lite">lite —— 桌面常用（核心 + 桌面 + 文件）</option>
        <option value="lazy">lazy —— 只留 3 个入口，其余现场加载</option>
      </select>
      <em>省上下文用。改完需要重载插件才生效；lazy 下缺的能力用 computer_tools action=enable group=… 现场加载。</em>
    </label>
  </div>

  <div class="card"><h2>急停</h2>
    ${field('stopHoldMs', 'Esc/按钮保持时长(ms)', state.stopHoldMs, '按下后这么久内所有改动类动作被拒；实测人的往返要 10–30 秒', 'type="number" min="1000" max="600000" step="1000"')}
  </div>

  <div class="card"><h2>确认与批量 ⚠</h2>
    ${field('confirmTimeoutMs', '确认窗超时(ms)', state.confirmTimeoutMs, '30 秒不点=拒绝。不建议改短于 5 秒', 'type="number" min="5000" max="300000" step="1000"')}
    ${field('bulkThreshold', '批量升级阈值(项)', state.bulkThreshold, '覆盖/移动达到这个数量就升级为弹窗确认', 'type="number" min="1" max="1000"')}
    ${field('maxBatch', '单次批量上限(项)', state.maxBatch, '超过直接拒绝，提示分批', 'type="number" min="1" max="5000"')}
    ${field('observationTtlMs', '观察新鲜度(ms)', state.observationTtlMs, '坐标点击必须在这个时间内观察过目标', 'type="number" min="5000" max="600000" step="5000"')}
  </div>

  <div class="card"><h2>文件作用域</h2>
    ${area('allowRoots', '允许的根目录', state.allowRoots, '留空=不额外限制（系统目录仍是硬红线）；填了则域外操作升级为弹窗确认')}
  </div>

  <div class="card"><h2>应用白名单 ⚠</h2>
    ${area('allowedApps', '可直接启动的程序', state.allowedApps, '一行一个可执行文件名；名单外启动要过弹窗')}
    ${area('protectedProcesses', '禁止结束的进程', state.protectedProcesses, '一行一个进程名；结束它们会锁死桌面或系统')}
  </div>

  <div class="card"><h2>浏览器（CDP 通道）</h2>
    ${field('browser.exePath', '浏览器可执行文件', state.browser?.exePath ?? '', '留空=自动找 Edge/Chrome')}
    ${toggle('browser.headless', '无头模式', state.browser?.headless !== false, '开=完全不打扰你；需要人工登录时在工具里传 visible=true')}
  </div>

  <div class="card"><h2>保留期（天）</h2>
    ${field('logRetentionDays', '审计日志', state.logRetentionDays, '', 'type="number" min="1" max="3650"')}
    ${field('shotRetentionDays', '截图', state.shotRetentionDays, '', 'type="number" min="1" max="3650"')}
    ${field('trashRetentionDays', '隔离区（删除的文件）', state.trashRetentionDays, '', 'type="number" min="1" max="3650"')}
  </div>
</form>

<div class="bar">
  <button class="btn primary" id="save">保存</button>
  <button class="btn" id="reload">重新读取</button>
  <span id="msg"></span>
</div>

<script>
(function(){
  var base='${p}';
  var msg=document.getElementById('msg');
  function say(t,cls){msg.textContent=t;msg.className=cls||'';}
  function num(v){var n=Number(v);return Number.isFinite(n)?n:undefined;}

  function paintStatus(s){
    if(!s){document.getElementById('stat').textContent='（读取失败）';return;}
    var lines=[];
    lines.push('总闸：'+(s.paused?'⏸ 已暂停':'▶ 允许执行'));
    lines.push('模式：'+(s.nonIntrusive===false?'可接管键鼠（需逐次确认）':'非侵入（不移动你的鼠标）'));
    lines.push('急停：'+(s.stopped?('⚠ 已停止（来源 '+s.source+'，还剩 '+Math.ceil(s.remainingMs/1000)+' 秒）'):'当前未在停止中'));
    var w=s.escWatcher||{};
    lines.push('Esc 监听：'+(w.running?('运行中 pid='+w.pid+'，心跳 '+(w.heartbeatAgeMs?Math.round(w.heartbeatAgeMs/1000):'?')+'s 前'):'未运行'));
    if(w.lastEscAt){lines.push('上次 Esc：'+Math.round((Date.now()-w.lastEscAt)/1000)+'s 前'+(w.lastEscArmed?'（当时正在做事）':'（当时空闲）'));}
    var lk=s.lock||{};
    lines.push('桌面占用：'+(lk.held?((lk.tool||'未知')+' 正在操作，持有 '+Math.round((lk.ageMs||0)/1000)+'s'):'空闲（同一时刻只允许一个会话改动电脑）'));
    if(s.escWatcherError){lines.push('⚠ '+s.escWatcherError);}
    document.getElementById('stat').textContent=lines.join('\\n');
  }
  function loadStatus(){
    return fetch(base+'/settings/status',{cache:'no-store'}).then(function(r){return r.json();}).then(paintStatus).catch(function(){paintStatus(null);});
  }

  document.getElementById('save').addEventListener('click', function(){
    var f=document.getElementById('f');
    var body={
      paused: !f.paused.checked,
      toolMode: f.toolMode.value,
      nonIntrusive: f.nonIntrusive.checked,
      stopHoldMs: num(f.stopHoldMs.value),
      confirmTimeoutMs: num(f.confirmTimeoutMs.value),
      bulkThreshold: num(f.bulkThreshold.value),
      maxBatch: num(f.maxBatch.value),
      observationTtlMs: num(f.observationTtlMs.value),
      logRetentionDays: num(f.logRetentionDays.value),
      shotRetentionDays: num(f.shotRetentionDays.value),
      trashRetentionDays: num(f.trashRetentionDays.value),
      allowRoots: f.allowRoots.value,
      allowedApps: f.allowedApps.value,
      protectedProcesses: f.protectedProcesses.value,
      browser: { exePath: f['browser.exePath'].value, headless: f['browser.headless'].checked }
    };
    var btn=this; btn.disabled=true; say('保存中…');
    fetch(base+'/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.json();}).then(function(res){
        if(res.ok){ say('已保存'+(res.errors&&res.errors.length?('（'+res.errors.join('；')+'）'):'')+(res.needsReload?' · 工具集预设需要重载插件后生效':''),'ok'); }
        else { say('保存失败：'+(res.error||'未知'),'err'); }
      }).catch(function(e){ say('保存失败：'+e,'err'); })
      .then(function(){ btn.disabled=false; loadStatus(); });
  });
  document.getElementById('reload').addEventListener('click', function(){ location.reload(); });
  loadStatus();
  setInterval(loadStatus, 3000);
})();
</script>
</body></html>`;
}
