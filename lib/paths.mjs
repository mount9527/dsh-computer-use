// 目录约定：所有运行期数据都放在 $DSH_HOME/computer-use 下，不污染工作区。
import { homedir } from 'node:os';
import { join } from 'node:path';

export function dshHome() {
  const env = process.env.DSH_HOME;
  return env && env.trim() ? env : join(homedir(), '.dsh');
}

export const dataDir = () => join(dshHome(), 'computer-use');
export const stateFile = () => join(dataDir(), 'state.json');
export const runDir = () => join(dataDir(), 'run');
export const shotsDir = () => join(dataDir(), 'shots');
export const logsDir = () => join(dataDir(), 'logs');
export const backupsDir = () => join(dataDir(), 'backups');
export const trashDir = () => join(dataDir(), 'trash');
