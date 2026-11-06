// 审计留痕：每一次动作一行 JSONL，出问题能回放「什么时候、对什么、谁批准的」。
// 同时负责截图 / 隔离区 / 日志的保留期清理。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupsDir, logsDir, shotsDir, trashDir } from './paths.mjs';
import { mask } from './policy.mjs';

function dayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

export function auditFile(date = new Date()) {
  return join(logsDir(), `audit-${dayKey(date)}.jsonl`);
}

let lastPrune = 0;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function pruneDir(dir, keepDays) {
  if (!keepDays || keepDays <= 0) return 0;
  let removed = 0;
  let entries;
  try { entries = readdirSync(dir); } catch { return 0; }
  const cutoff = Date.now() - keepDays * 86400000;
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs >= cutoff) continue;
      rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch { /* 被占用就下次再清 */ }
  }
  return removed;
}

/** 保留期清理：按目录整体过期，不做逐条删除（审计记录的完整性优先）。 */
export function prune(force = false) {
  const now = Date.now();
  if (!force && now - lastPrune < PRUNE_INTERVAL_MS) return { removed: 0 };
  lastPrune = now;
  let removed = 0;
  try {
    removed += pruneDir(logsDir(), 30);
    removed += pruneDir(shotsDir(), 7);
    removed += pruneDir(trashDir(), 7);
    removed += pruneDir(backupsDir(), 7);
  } catch { /* 忽略 */ }
  return { removed };
}

/**
 * 追加一条审计记录。写失败不影响主流程（宁可少一条日志，也不要让动作因为日志失败而半途中断）。
 */
export function appendAudit(entry) {
  try {
    mkdirSync(logsDir(), { recursive: true });
    prune();
    const record = {
      ts: new Date().toISOString(),
      tool: entry.tool,
      action: entry.action ?? '',
      level: entry.level ?? '',
      confirm: entry.confirm ?? 'none',
      ok: entry.ok !== false,
      summary: mask(entry.summary ?? ''),
      digest: entry.digest ? String(entry.digest).slice(0, 16) : undefined,
      targets: Array.isArray(entry.targets) ? entry.targets.slice(0, 50).map(mask) : undefined,
      evidence: Array.isArray(entry.evidence) ? entry.evidence.slice(0, 10).map(mask) : undefined,
      agent: entry.agent ? String(entry.agent).slice(0, 40) : undefined,
      durationMs: entry.durationMs,
      error: entry.error ? mask(entry.error) : undefined,
    };
    appendFileSync(auditFile(), `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  } catch {
    return null;
  }
}

/** 读最近的审计行（跨天文件，从新到旧）。 */
export function readRecent(limit = 20) {
  const dir = logsDir();
  let files;
  try { files = readdirSync(dir).filter((f) => /^audit-\d{8}\.jsonl$/.test(f)).sort().reverse(); }
  catch { return []; }
  const out = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try { out.push(JSON.parse(lines[i])); } catch { /* 跳过坏行 */ }
    }
    if (out.length >= limit) break;
  }
  return out;
}

export function shotPath(tool, ext = 'png') {
  const dir = shotsDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 7);
  return join(dir, `${stamp}-${tool}-${rand}.${ext}`);
}

/** 备份清单：L2+ 改文件前把原件复制到这里，撤销时按清单还原。 */
export function runDirFor(kind, runId) {
  const base = kind === 'trash' ? trashDir() : backupsDir();
  const dir = join(base, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeManifest(runId, manifest) {
  const dir = join(backupsDir(), runId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'manifest.json');
  writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8');
  return file;
}

export function readManifest(runId) {
  const file = join(backupsDir(), runId, 'manifest.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function listManifests(limit = 10) {
  const dir = backupsDir();
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const rows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(entry.name);
    if (manifest) rows.push({ runId: entry.name, ...manifest });
  }
  rows.sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
  return rows.slice(0, limit);
}
