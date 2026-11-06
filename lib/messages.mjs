// 错误信息本地化：把内部标识（错误码、errno、英文异常）翻成用户和模型都能读懂的中文。
//
// 为什么不在 desk.ps1 里直接写中文：Windows PowerShell 5.1 把**无 BOM** 的 UTF-8 脚本按 ANSI 读，
// 中文会变成乱码并让解析失败。所以脚本只吐稳定的错误码，中文放在 Node 这一侧。

/** desk.ps1 的错误码 → 中文说明 + 下一步建议。detail 是原始技术信息，追在括号里。 */
const DESK_CODES = {
  UIA_TREE_UNREADABLE: {
    text: '读不到这个窗口的 UI 自动化树（它没有暴露可访问性信息）',
    hint: '改用 computer_screenshot（ocr=true）读屏幕，或先用 computer_app action=show 把窗口显示出来再试',
  },
  SPAWN_FAILED: {
    text: '启动这个程序失败',
    hint: '确认可执行文件名正确；不在 PATH 里的程序要给绝对路径',
  },
  ELEMENT_NO_INVOKE: {
    text: '这个控件不支持 Invoke（程序化"按一下"）',
    hint: '改用 computer_ui action=click（会先试控件自己的点击，再发窗口消息），或退到坐标点击',
  },
  ELEMENT_NO_SETVALUE: {
    text: '这个控件不支持 SetValue（程序化赋值）',
    hint: '改用 computer_ui action=type（非侵入地把文字送进控件窗口），或 computer_input type',
  },
  ELEMENT_NO_SELECT: {
    text: '这个控件不支持程序化选中',
    hint: '用 computer_ui action=click 先点开它，再用键盘上下键选择',
  },
  ELEMENT_NO_TOGGLE: {
    text: '这个控件不支持程序化开关',
    hint: '用 computer_ui action=click 点它',
  },
  ELEMENT_NO_EXPAND: {
    text: '这个控件不支持展开',
    hint: '用 computer_ui action=click 点它',
  },
  ELEMENT_NO_COLLAPSE: {
    text: '这个控件不支持折叠',
    hint: '用 computer_ui action=click 点它',
  },
  ELEMENT_NO_SCROLL: {
    text: '这个控件不支持滚动到可见位置',
    hint: '改用 computer_input action=scroll（需要授权），或用 computer_ui 换一个滚动容器',
  },
  ELEMENT_NOT_FOUND: {
    text: '没找到符合条件的控件',
    hint: '先用 computer_ui mode=tree 看当前真实结构，路径和名称可能已经变了',
  },
  CLICK_BLOCKED: {
    text: '点击被系统拦下了（目标进程的权限比本插件高，UIPI 拦住了消息）',
    hint: '这是权限边界，不是参数错误：需要用户以同等权限运行 DSH，或改用别的通道；不要反复重试',
  },
  OCR_FAILED: {
    text: 'OCR 失败',
    hint: '检查系统是否装了对应语言的 OCR 语言包，或换 en-US / zh-Hans-CN 试一次',
  },
  INTEROP_INIT_FAILED: {
    text: '本机缺少 .NET Framework 4.x 或 System.Drawing，无法初始化桌面互操作层',
    hint: '装上 .NET Framework 4.x 后重启 DSH',
  },
  STALE_HANDLE: {
    text: '窗口句柄无效或已经关闭',
    hint: '窗口可能已经关掉了：用 computer_windows 重新找一次',
  },
  BAD_ARG: {
    text: '参数不合法',
    hint: '检查这个工具的枚举取值（mode / action / op / kind）',
  },
};

/** fs 的 errno → 中文。fs 的错误只带英文 message，必须自己翻译。 */
const FS_CODES = {
  ENOENT: '路径不存在',
  EPERM: '权限不足（操盘系统拒绝）',
  EACCES: '没有权限访问这个路径',
  EBUSY: '文件正被其它程序占用',
  EEXIST: '目标已存在',
  ENOTEMPTY: '目录不是空的',
  EISDIR: '目标是一个目录',
  ENOTDIR: '路径中有一段不是目录',
  EROFS: '文件系统是只读的',
  ENOSPC: '磁盘空间不足',
  ENAMETOOLONG: '路径太长',
  UNKNOWN: '未知系统错误',
};

/** CDP / 浏览器侧的常见英文异常 → 中文。 */
const BROWSER_PHRASES = [
  [/cannot connect to (edge|chrome)|DevToolsActivePort/i, '连不上浏览器的调试端口（浏览器可能没能启动）'],
  [/Target closed|Session closed|page has been closed/i, '页面已经关闭了'],
  [/No node with given id|Could not find node|node is detached/i, '页面元素已经不存在（页面变化了）'],
  [/Execution context was destroyed|Cannot find context/i, '页面在操作过程中跳转/刷新了'],
  [/net::ERR_[A-Z_]+/i, '网页打不开（网络错误）'],
  [/Timeout .*exceeded|timed out/i, '等待超时'],
  [/EADDRINUSE|port is already in use/i, '端口被占用'],
  [/ENOENT|no such file or directory/i, '文件或路径不存在'],
  [/blocked|CORS/i, '被浏览器安全策略拦住了'],
];

function detailOf(text) {
  const s = String(text ?? '');
  const idx = s.indexOf(':');
  if (idx <= 0 || idx > 90) return '';
  return s.slice(idx + 1).trim();
}

/**
 * 把 desk 的失败结果翻成中文。
 * 保留原始信息为「技术细节」，方便排查，但不让英文出现在主句里。
 */
export function localizeDeskFailure(result) {
  if (!result || result.ok) return result;
  const raw = String(result.error ?? '');
  const code = String(result.code ?? '');
  const mapped = DESK_CODES[code];

  if (mapped) {
    const detail = detailOf(raw);
    const lines = [mapped.text + (detail ? `（技术细节：${detail}）` : '')];
    if (mapped.hint) lines.push(`下一步：${mapped.hint}`);
    for (const hint of Array.isArray(result.hints) ? result.hints : []) {
      const zh = translateHint(hint);
      if (zh && !lines.includes(zh)) lines.push(`提示：${zh}`);
    }
    return { ...result, error: lines.join('\n'), code };
  }

  // 没有码：至少把常见的英文片段换掉，并标明这是未归类的错误
  const translated = translatePhrase(raw);
  return {
    ...result,
    error: translated === raw
      ? `桌面操作失败：${raw || '（没有给出原因）'}`
      : `桌面操作失败：${translated}`,
    code: code || undefined,
  };
}

function translateHint(hint) {
  const s = String(hint ?? '').trim();
  if (!s) return '';
  const table = [
    [/try action=click instead/i, '换成 computer_ui action=click 试试'],
    [/use action=type/i, '改用 computer_ui action=type 送文字'],
    [/give an absolute path/i, '给绝对路径，或用 PATH 里存在的名字'],
    [/may lack \.NET/i, '本机可能缺 .NET Framework 4.x'],
    [/run as administrator/i, '可能需要以管理员身份运行'],
    [/scroll|offscreen/i, '目标可能不在屏幕内，先滚动到可见位置'],
  ];
  for (const [re, zh] of table) {
    if (re.test(s)) return zh;
  }
  // 已经是中文的直接用
  return /[\u4e00-\u9fa5]/.test(s) ? s : '';
}

/** 把 fs 抛出来的英文错误翻成「中文说明（ERRNO）」 */
export function describeFsError(err, target = '') {
  const code = String(err?.code ?? 'UNKNOWN');
  const zh = FS_CODES[code] ?? FS_CODES.UNKNOWN;
  const where = target ? `：${target}` : '';
  return `${zh}${where}（${code}）`;
}

/** 把浏览器/CDP 的英文异常翻成中文；认不出就原样保留并加前缀 */
export function describeBrowserError(err) {
  const raw = String(err?.message ?? err ?? '');
  // 已经是中文的（例如 lib/browser.mjs 自己写的中文提示）不要再包一层
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw;
  for (const [re, zh] of BROWSER_PHRASES) {
    if (re.test(raw)) return `${zh}（原始信息：${raw.slice(0, 200)}）`;
  }
  return `浏览器操作失败：${raw.slice(0, 300)}`;
}

function translatePhrase(text) {
  const s = String(text ?? '');
  // 先认完整句式，能给出可操作的整句，而不是一个词
  const phrases = [
    [/window handle is invalid/i, '窗口句柄无效或已经关闭（窗口可能已关闭，用 computer_windows 重新找一次）'],
    [/does not support/i, '不支持这个操作（换一种动作，例如 action=click 或 action=type）'],
    [/access is denied/i, '访问被拒绝（权限不足）'],
    [/is not running/i, '目标程序没有在运行'],
  ];
  for (const [re, zh] of phrases) {
    if (re.test(s)) return zh;
  }
  const rules = [
    [/not found|no such/i, '找不到目标'],
    [/invalid/i, '参数或状态无效'],
    [/timed out|timeout/i, '超时'],
    [/denied|forbidden/i, '被拒绝'],
    [/initialize/i, '初始化失败'],
  ];
  for (const [re, zh] of rules) {
    if (re.test(s)) return `${zh}（原始信息：${s.slice(0, 200)}）`;
  }
  return s;
}
