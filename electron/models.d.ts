import type {
  GameInput,
  Snapshot,
  ImportItem,
  ImportPlan,
  ImportDecision,
  Language,
  Theme,
  RestorePointRetention,
} from '../shared/contracts';

// 单个备份文件或目录的元数据与 SHA-256 摘要记录
export interface FileRecord {
  path: string;
  type: 'file' | 'directory';
  mtimeMs: number;
  size?: number;
  sha256?: string;
}
// 存档目录扫描清单：records 为已存在的文件/目录列表，absent 为配置中允许缺失的路径列表
export interface Inventory {
  records: FileRecord[];
  absent: string[];
}
// 持久化在每个快照目录 manifest.json 中的完整清单模型
export interface Manifest extends Snapshot, Inventory {
  version: 1;
  fingerprint: string;
  origin?: { path?: string; gameId?: string; snapshotId?: string };
}
// 持久化在 library.json 与游戏目录 game.json 中的游戏配置模型
export interface StoredGame extends GameInput {
  id: string;
  createdAt: string;
  deletedAt?: string;
  purgeGamePending?: boolean;
  purgeSnapshotsPending?: boolean;
  origin?: { gameId: string; path: string };
  importOrigin?: { id: string };
}
// 全局配置文件 library.json 的持久化结构
export interface LibraryConfig {
  version: number;
  games: StoredGame[];
  theme: Theme;
  language: Language;
  restorePointRetention: RestorePointRetention;
  logLimitMB: number;
  maxRestorePoints?: number;
}
// 读档事务日志（WAL）：记录准备、替换进度、已提交或已回滚状态，用于崩溃后幂等恢复
export interface RestoreJournal {
  version: number;
  id: string;
  gameId: string;
  snapshotId?: string;
  safetyId?: string;
  root: string;
  stage: string;
  entries: string[];
  operations: { entry: string; hadTarget: boolean }[];
  status: 'preparing' | 'applying' | 'committed' | 'rolled-back';
}
// 导入覆盖替换事务日志：保证覆盖现有快照时的原子切换与崩溃恢复
export interface ImportReplacementJournal {
  version: number;
  token: string;
  gameId: string;
  id: string;
  status: 'prepared' | 'committed';
}
// 主进程内部保存的导入候选项与导入计划（含完整文件指纹与清单，不直接暴露给渲染进程）
export interface ImportCandidate extends ImportItem {
  fingerprint: string;
  entries?: string[];
  bundle?: boolean;
  meta?: Manifest;
  exported?: string;
  allowMissing?: boolean;
  note?: string;
  favorite?: boolean;
  protected?: boolean;
}
export interface InternalImportPlan extends ImportPlan {
  entries: string[];
  items: ImportCandidate[];
  bundle: boolean;
  indexHash?: string;
}
export type ImportChoices = Map<string, ImportDecision>;
