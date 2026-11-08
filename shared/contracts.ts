// 主题、语言与支持的目标平台类型定义
export type Theme = 'ink' | 'tech' | 'cyber' | 'glass';
export type Language = 'zh' | 'en';
export type Platform = 'win32' | 'darwin';
// 自动恢复点保留策略：active 为正常恢复点上限，removed 为已移除恢复点队列上限
export interface RestorePointRetention {
  active: number;
  removed: number;
}
// 单个平台下的存档目录配置：root 为绝对根目录，items 为相对于 root 的备份路径列表
export interface Location {
  root: string;
  items: string[];
}
// 对外暴露的快照摘要模型（不包含内部文件级 records 明细，降低 IPC 传输体积）
export interface Snapshot {
  id: string;
  gameId: string;
  label: string;
  note: string;
  kind: 'manual' | 'safety' | 'imported';
  createdAt: string;
  updatedAt: string;
  platform: Platform;
  entries: string[];
  absent: string[];
  fileCount: number;
  bytes: number;
  favorite?: boolean;
  protected?: boolean;
  deletedAt?: string;
  corrupted?: boolean;
  error?: string;
  purgePending?: boolean;
}
// 新增或编辑游戏时的表单输入载荷
export interface GameInput {
  id?: string;
  name: string;
  subtitle: string;
  icon: string;
  color: string;
  locations: Record<Platform, Location>;
  legacyRoot: string;
  restorePointRetention?: Partial<RestorePointRetention>;
}
// 前端渲染层使用的完整游戏状态模型
export interface Game extends GameInput {
  id: string;
  createdAt: string;
  deletedAt?: string;
  purgeGamePending?: boolean;
  purgeSnapshotsPending?: boolean;
  snapshots: Snapshot[];
  restorePoints: Snapshot[];
  pathStatus: 'ready' | 'unconfigured' | 'missing';
  legacyCount: number;
  restorePointRetentionEffective: RestorePointRetention;
  recoveryBlocked?: boolean;
}
// 应用全局状态快照，由主进程 state() 聚合后下发至渲染进程
export interface AppState {
  games: Game[];
  theme: Theme;
  language: Language;
  platform: Platform;
  dataDir: string;
  recoveryMessages: string[];
  version: string;
  restorePointRetention: RestorePointRetention;
  logLimitMB: number;
}
// 后台长耗时任务的阶段枚举与进度载荷
export type ProgressPhase = 'checking' | 'copying' | 'restoring' | 'deleting' | 'importing' | 'exporting' | 'pruning';
export interface Progress {
  phase: ProgressPhase;
  detail: string;
  completed: number;
  total?: number;
  percent?: number;
}
// 导入冲突处理动作：覆盖本地同名/同源项、跳过本次导入、或重命名共存
export type ImportAction = 'overwrite' | 'skip' | 'keep-both';
export interface ImportDecision {
  itemId: string;
  action: ImportAction;
  targetId?: string;
}
export interface ImportItem {
  id: string;
  name: string;
  source: string;
  bytes: number;
  fileCount: number;
  matches: Snapshot[];
}
// 存档导入预检计划：在实际写入前返回冲突候选供用户确认
export interface ImportPlan {
  id: string;
  gameId: string;
  directory: string;
  items: ImportItem[];
  failed: { name: string; error: string }[];
}
// 存档导入执行结果报告（含恢复点队列自动裁剪统计 pruned）
export interface ImportReport {
  imported: string[];
  overwritten: string[];
  keptBoth: string[];
  skipped: string[];
  failed: { name: string; error: string }[];
  pruned?: { movedCount: number; purgedCount: number };
}
export interface BatchReport {
  updated: string[];
  failed: { id: string; label: string; error: string }[];
}
export interface ExportResult {
  folder: string;
  count: number;
}
export interface GameImportItem {
  id: string;
  game: GameInput & { id: string; createdAt: string };
  source: string;
  includesSnapshots: boolean;
  matches: (GameInput & {
    id: string;
    createdAt: string;
    deletedAt?: string;
    purgeGamePending?: boolean;
    purgeSnapshotsPending?: boolean;
  })[];
}
// 整包游戏导入三阶段流程：1. 预检游戏冲突(GameImportPlan) -> 2. 审查附带存档冲突(GameImportReview) -> 3. 执行导入(GameImportReport)
export interface GameImportPlan {
  id: string;
  directory: string;
  items: GameImportItem[];
  failed: { name: string; error: string }[];
}
export interface GameImportReview {
  id: string;
  planId: string;
  failed: { name: string; error: string }[];
  games: { itemId: string; name: string; action: ImportAction | 'import'; snapshots: ImportPlan | null }[];
}
export interface GameSnapshotDecision {
  itemId: string;
  decisions: ImportDecision[];
}
export interface GameImportReport {
  games: ImportReport;
  snapshots: { gameName: string; report: ImportReport }[];
}
// Preload 暴露在 window.savehub 上的跨进程通信桥接契约
export interface Bridge {
  state(): Promise<AppState>;
  setTheme(theme: Theme): Promise<void>;
  setLanguage(language: Language): Promise<void>;
  setRestorePointRetention(value: RestorePointRetention): Promise<void>;
  setLogLimitMB(value: number): Promise<void>;
  saveGame(game: GameInput): Promise<string>;
  reorderGames(ids: string[]): Promise<void>;
  removeGame(id: string, undo?: boolean, deleteRecords?: boolean): Promise<void>;
  exportGames(ids: string[], includeSnapshots?: boolean): Promise<(ExportResult & { snapshotCount: number }) | null>;
  importGames(): Promise<GameImportPlan | null>;
  reviewGameImport(planId: string, decisions: ImportDecision[]): Promise<GameImportReview>;
  executeGameImport(reviewId: string, decisions: GameSnapshotDecision[]): Promise<GameImportReport>;
  cancelGameImport(planId: string): Promise<void>;
  pickDirectory(): Promise<string | null>;
  pickIcon(): Promise<string | null>;
  saveSnapshot(id: string, details: { label: string; note: string }): Promise<Snapshot>;
  restoreSnapshot(gameId: string, id: string): Promise<{ safetyId: string; label: string }>;
  updateSnapshot(
    gameId: string,
    id: string,
    details: { label?: string; note?: string; favorite?: boolean; protected?: boolean; deleted?: boolean },
  ): Promise<void>;
  updateSnapshots(
    gameId: string,
    ids: string[] | 'all',
    details: { deleted: boolean } | { protected: boolean },
  ): Promise<BatchReport>;
  deleteSnapshots(gameId: string, ids: string[]): Promise<BatchReport>;
  verifySnapshot(gameId: string, id: string): Promise<{ fileCount: number; bytes: number }>;
  importSnapshots(id: string, useLegacy?: boolean): Promise<ImportPlan | null>;
  executeImport(planId: string, decisions: ImportDecision[]): Promise<ImportReport>;
  cancelImport(planId: string): Promise<void>;
  exportSnapshot(gameId: string, id: string): Promise<string | null>;
  exportSnapshots(gameId: string, ids: string[] | 'all'): Promise<ExportResult | null>;
  openFolder(kind: 'vault' | 'logs' | 'game' | 'snapshots', id?: string): Promise<void>;
  onProgress(callback: (progress: Progress | null) => void): () => void;
}
declare global {
  interface Window {
    savehub?: Bridge;
  }
}

export type CommandName = Exclude<keyof Bridge, 'onProgress'>;
export type Commands = Pick<Bridge, CommandName>;
export interface ErrorPayload {
  code: string;
  params: Record<string, string | number>;
  message: string;
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: ErrorPayload };
