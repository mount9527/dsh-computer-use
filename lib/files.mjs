// 文件操作：先出计划 → 需要时走确认 → 执行 → 留撤销清单。
// 删除不是真删，而是挪进 $DSH_HOME/computer-use/trash/<runId>/（可撤销），
// 只有显式 permanent=true 才是不可撤销（走 L3 模态）。
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeFsError } from './messages.mjs';
import { backupsDir, trashDir } from './paths.mjs';
import { redLineReasonForPath, isInsideRoots, homeShorthand } from './policy.mjs';
import { appendAudit, readManifest, runDirFor, writeManifest } from './audit.mjs';

const MAX_ITEMS = 500;

export function newRunId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** 只支持最后一段的简单通配（* 和 ?），不做 ** 递归——递归匹配是最容易失控的地方。 */
export function expandSources(sources) {
  const out = [];
  const missing = [];
  for (const raw of sources) {
    const source = String(raw ?? '').trim();
    if (!source) continue;
    if (/[*?]/.test(source)) {
      if (source.includes('**')) {
        missing.push({ source, reason: '** 递归通配不支持；请先用 list 看清目录再逐个列出，或按目录整体操作' });
        continue;
      }
      const dir = dirname(source);
      const pattern = basename(source);
      const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
      let entries = [];
      try { entries = readdirSync(dir); } catch { missing.push({ source, reason: '目录不存在或不可读' }); continue; }
      const matched = entries.filter((name) => regex.test(name)).map((name) => join(dir, name));
      if (matched.length === 0) missing.push({ source, reason: '没有匹配到任何文件' });
      out.push(...matched);
    } else if (existsSync(source)) {
      out.push(source);
    } else {
      missing.push({ source, reason: '路径不存在' });
    }
  }
  const unique = [...new Set(out.map((p) => p))];
  return { items: unique, missing };
}

/**
 * 生成计划。op: list | mkdir | copy | move | rename | delete | undo
 * 计划本身不改动磁盘（overwrite 的备份只在执行阶段做）。
 */
export function planOperation({ op, sources = [], target = '', name = '', overwrite = false, permanent = false, allowRoots = [], runId: forcedRunId = '' }) {
  // 确认弹窗向用户承诺的撤销 runId 必须就是最终执行用的那个，否则「所见非所执行」
  const runId = forcedRunId || newRunId();
  const entries = [];
  const problems = [];
  const warnings = [];
  let items = [];
  let missing = [];

  if (op === 'list') {
    const files = [];
    const dirs = [];
    const statOf = (p) => {
      try {
        const st = statSync(p);
        return { mtime: new Date(st.mtimeMs).toISOString(), size: st.size, isDir: st.isDirectory() };
      } catch {
        return { mtime: '', size: 0, isDir: false };
      }
    };
    for (const source of sources) {
      if (!existsSync(source)) { missing.push({ source, reason: '路径不存在' }); continue; }
      if (isDir(source)) {
        let children = [];
        try { children = readdirSync(source); } catch { problems.push(`${source}：目录不可读`); continue; }
        for (const child of children.slice(0, 200)) {
          const full = join(source, child);
          const info = statOf(full);
          const bucket = info.isDir ? dirs : files;
          bucket.push({ path: full, size: info.size, mtime: info.mtime });
        }
      } else {
        const info = statOf(source);
        files.push({ path: source, size: info.size, mtime: info.mtime });
      }
    }
    return { op, runId, items: [], files, dirs, missing, problems, warnings, level: 'L0' };
  }

  // mkdir 的目标本来就不存在，不能走「必须存在」的展开逻辑
  if (op === 'mkdir') {
    const dirs = sources.map((s) => String(s ?? '').trim()).filter(Boolean);
    if (dirs.length === 0) problems.push('mkdir 需要目标目录路径（sources）');
    for (const dir of dirs) {
      const red = redLineReasonForPath(dir);
      if (red) problems.push(`${dir}：位于受保护位置 ${red}，任何情况下都不允许创建`);
      if (existsSync(dir)) warnings.push(`${homeShorthand(dir)} 已存在，将保持不变`);
      if (!isInsideRoots(dir, allowRoots)) warnings.push(`${dir}：不在 allowRoots 范围内，需要额外确认`);
      entries.push({ action: 'mkdir', from: dir, to: null, existed: false });
    }
    return {
      op, runId, items: dirs, entries, missing: [], problems, warnings,
      overwriteCount: 0, count: entries.length, permanent: false, level: 'L1',
    };
  }

  const expanded = expandSources(sources);
  items = expanded.items;
  missing = expanded.missing;
  if (items.length > MAX_ITEMS) {
    problems.push(`目标数量 ${items.length} 超过单次上限 ${MAX_ITEMS}；请分批处理`);
    items = items.slice(0, MAX_ITEMS);
  }

  // 红线只针对"会被改写的位置"：写入目标，以及会从原位置拿走文件的破坏性操作。
  // 只读来源（copy 的来源、list）必须放行——否则插件自己存在 %DSH_HOME% 下的截图都导不出来。
  const destructive = op === 'delete' || op === 'move' || op === 'rename';
  for (const item of items) {
    if (destructive) {
      const red = redLineReasonForPath(item);
      const verb = op === 'delete' ? '删除' : '移出/改名';
      if (red) problems.push(`${item}：位于受保护位置 ${red}，任何情况下都不允许${verb}`);
    }
    if (!isInsideRoots(item, allowRoots)) warnings.push(`${item}：不在 allowRoots 范围内，需要额外确认`);
  }

  switch (op) {
    case 'copy':
    case 'move': {
      if (!target) problems.push(`${op} 需要 target（目标目录或目标文件）`);
      const targetIsDir = target ? isDir(target) : false;
      if (items.length > 1 && target && !targetIsDir && !target.endsWith('\\')) {
        problems.push('多个来源时 target 必须是已存在的目录');
      }
      for (const item of items) {
        if (isDir(item)) { problems.push(`${homeShorthand(item)}：目录的复制/移动请先 list 出内容再逐个处理`); continue; }
        const dest = (items.length === 1 && target && !targetIsDir && !target.endsWith('\\'))
          ? target
          : join(target, basename(item));
        if (existsSync(dest) && !overwrite) {
          problems.push(`${homeShorthand(dest)} 已存在；覆盖需要显式 overwrite=true（并会被要求确认）`);
        }
        const red = redLineReasonForPath(dest);
        if (red) problems.push(`${dest}：目标位于受保护位置 ${red}`);
        entries.push({ action: op, from: item, to: dest, existed: existsSync(dest) });
      }
      break;
    }
    case 'rename': {
      if (items.length !== 1) problems.push('rename 只能针对单个来源');
      if (!name) problems.push('rename 需要 name（新名字）');
      const from = items[0];
      if (from && name) {
        const to = join(dirname(from), name);
        if (existsSync(to)) problems.push(`${homeShorthand(to)} 已存在`);
        const red = redLineReasonForPath(to);
        if (red) problems.push(`${to}：目标位于受保护位置 ${red}`);
        entries.push({ action: 'rename', from, to, existed: false });
      }
      break;
    }
    case 'delete': {
      if (items.length === 0) problems.push('delete 没有可删除的目标');
      for (const item of items) {
        entries.push({ action: permanent ? 'delete-permanent' : 'trash', from: item, to: permanent ? null : null, existed: true });
      }
      break;
    }
    default:
      problems.push(`未知操作：${op}`);
  }

  const overwriteCount = entries.filter((e) => e.existed).length;
  // 分级对齐设计大纲：单个可逆移动 = L2；批量移动/覆盖 ≥ bulk = 由调用方升级为 L3；
  // 删除（含永久删除）永远是 L3。
  let level = 'L2';
  if (op === 'mkdir') level = 'L1';
  if (op === 'copy' || op === 'rename') level = overwriteCount > 0 ? 'L2' : 'L1';
  if (op === 'move') level = 'L2';
  if (op === 'delete') level = 'L3';

  return {
    op, runId, items, entries, missing, problems, warnings, level,
    overwriteCount, count: entries.length, permanent: Boolean(permanent),
  };
}

function uniqueDest(dir, index, originalName) {
  mkdirSync(dir, { recursive: true });
  return join(dir, `${index}-${basename(originalName)}`);
}

/**
 * 执行计划。返回 runId 与逐项结果；任何时候都不抛异常。
 * @param {object} plan 来自 planOperation
 * @param {object} options { agent }
 */
export function executePlan(plan, options = {}) {
  const started = Date.now();
  const applied = [];
  const failed = [];
  const backupDir = runDirFor('backup', plan.runId);
  let index = 0;

  for (const entry of plan.entries) {
    index += 1;
    try {
      switch (entry.action) {
        case 'mkdir': {
          mkdirSync(entry.from, { recursive: true });
          applied.push({ ...entry, action: 'mkdir' });
          break;
        }
        case 'copy': {
          let backup = null;
          if (entry.existed) {
            backup = join(backupDir, `${index}-${basename(entry.from)}`);
            cpSync(entry.from, backup, { recursive: true, force: true });
          }
          mkdirSync(dirname(entry.to), { recursive: true });
          cpSync(entry.from, entry.to, { recursive: true, force: true });
          applied.push({ ...entry, backup });
          break;
        }
        case 'rename':
        case 'move': {
          let backup = null;
          if (entry.existed && entry.to) {
            backup = join(backupDir, `${index}-${basename(entry.to)}`);
            cpSync(entry.to, backup, { recursive: true, force: true });
          }
          mkdirSync(dirname(entry.to), { recursive: true });
          try {
            renameSync(entry.from, entry.to);
          } catch (err) {
            if (err && (err.code === 'EXDEV' || err.code === 'EPERM')) {
              cpSync(entry.from, entry.to, { recursive: true, force: true });
              rmSync(entry.from, { recursive: true, force: true });
            } else {
              throw err;
            }
          }
          applied.push({ ...entry, backup });
          break;
        }
        case 'trash': {
          const dest = uniqueDest(join(trashDir(), plan.runId), index, entry.from);
          try {
            renameSync(entry.from, dest);
          } catch (err) {
            if (err && (err.code === 'EXDEV' || err.code === 'EPERM')) {
              cpSync(entry.from, dest, { recursive: true, force: true });
              rmSync(entry.from, { recursive: true, force: true });
            } else {
              throw err;
            }
          }
          applied.push({ ...entry, to: dest });
          break;
        }
        case 'delete-permanent': {
          rmSync(entry.from, { recursive: true, force: true });
          applied.push({ ...entry, undoable: false });
          break;
        }
        default:
          failed.push({ ...entry, error: `未知条目动作 ${entry.action}` });
      }
    } catch (err) {
      failed.push({ ...entry, error: describeFsError(err, entry.to || entry.from || '') });
    }
  }

  const undoable = applied.length > 0 && !applied.some((e) => e.action === 'delete-permanent');
  let manifestFile = null;
  try {
    manifestFile = writeManifest(plan.runId, {
      runId: plan.runId,
      at: new Date().toISOString(),
      op: plan.op,
      level: plan.level,
      permanent: plan.permanent,
      undoable,
      entries: applied,
    });
  } catch { /* 清单写失败不影响已完成的动作，但撤销会不可用 */ }

  appendAudit({
    tool: 'computer_files',
    action: plan.op,
    level: plan.level,
    // 记录这次动作到底是"用户点过执行"还是"不需要确认"——审计里必须能分辨，
    // 否则一条 L3 记录会看起来像"没确认就执行了"
    confirm: options.confirm ?? 'none',
    ok: failed.length === 0,
    summary: `${plan.op} ${applied.length} 项${failed.length ? `，${failed.length} 项失败` : ''}`,
    targets: applied.map((e) => e.from),
    evidence: manifestFile ? [manifestFile] : undefined,
    agent: options.agent,
    durationMs: Date.now() - started,
    error: failed.length ? failed[0].error : undefined,
  });

  return { runId: plan.runId, applied, failed, undoable, manifestFile, trashDir: undoable ? join(trashDir(), plan.runId) : null };
}

/** 按清单逆序撤销一次操作。 */
export function undoRun(runId, options = {}) {
  const manifest = readManifest(runId);
  if (!manifest) return { ok: false, error: `找不到撤销清单：${runId}` };
  if (!manifest.undoable) return { ok: false, error: `${runId} 是不可撤销操作（永久删除）` };

  const restored = [];
  const failed = [];
  const entries = Array.isArray(manifest.entries) ? manifest.entries.slice().reverse() : [];
  for (const entry of entries) {
    try {
      switch (entry.action) {
        case 'mkdir':
          try { rmSync(entry.from, { recursive: false, force: false }); } catch { /* 非空则保留 */ }
          restored.push({ action: 'rmdir', path: entry.from });
          break;
        case 'copy': {
          if (entry.existed && entry.backup && existsSync(entry.backup)) {
            cpSync(entry.backup, entry.to, { recursive: true, force: true });
            restored.push({ action: 'restore-overwritten', path: entry.to });
          } else {
            rmSync(entry.to, { recursive: true, force: true });
            restored.push({ action: 'remove-created', path: entry.to });
          }
          break;
        }
        case 'rename':
        case 'move':
        case 'trash': {
          if (!existsSync(entry.to)) { failed.push({ ...entry, error: '源已不在原位置，无法还原' }); break; }
          mkdirSync(dirname(entry.from), { recursive: true });
          try {
            renameSync(entry.to, entry.from);
          } catch (err) {
            if (err && (err.code === 'EXDEV' || err.code === 'EPERM')) {
              cpSync(entry.to, entry.from, { recursive: true, force: true });
              rmSync(entry.to, { recursive: true, force: true });
            } else {
              throw err;
            }
          }
          restored.push({ action: 'move-back', path: entry.from });
          break;
        }
        default:
          failed.push({ ...entry, error: `条目动作 ${entry.action} 不支持撤销` });
      }
    } catch (err) {
      failed.push({ ...entry, error: describeFsError(err, entry.to || entry.from || '') });
    }
  }

  // 撤销后清单标记为已用，避免重复撤销造成二次破坏
  try {
    writeFileSync(join(backupsDir(), runId, 'undone.json'), JSON.stringify({ at: new Date().toISOString(), restored: restored.length }), 'utf8');
  } catch { /* 忽略 */ }

  appendAudit({
    tool: 'computer_files',
    action: `undo:${runId}`,
    level: 'L2',
    ok: failed.length === 0,
    summary: `撤销 ${restored.length} 项${failed.length ? `，${failed.length} 项失败` : ''}`,
    targets: entries.map((e) => e.from),
    agent: options.agent,
    error: failed.length ? failed[0].error : undefined,
  });

  return { ok: failed.length === 0, runId, restored, failed };
}
