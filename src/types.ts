export type Theme = 'ink' | 'tech' | 'cyber' | 'glass';
export type Platform = 'win32' | 'darwin';
export interface Location { root: string; items: string[] }
export interface Snapshot {
  id: string; gameId: string; label: string; note: string; kind: 'manual' | 'safety' | 'imported';
  createdAt: string; platform: Platform; entries: string[]; absent: string[]; fileCount: number; bytes: number;
  favorite?: boolean; protected?: boolean; deletedAt?: string; corrupted?: boolean; error?: string; purgePending?: boolean;
}
export interface GameInput {
  id?: string; name: string; subtitle: string; icon: string; color: string;
  locations: Record<Platform, Location>; legacyRoot: string;
}
export interface Game extends GameInput {
  id: string; createdAt: string; deletedAt?: string; snapshots: Snapshot[]; restorePoints: Snapshot[];
  pathStatus: 'ready' | 'unconfigured' | 'missing'; legacyCount: number;
}
export interface AppState { games: Game[]; theme: Theme; platform: Platform; dataDir: string; recoveryMessages: string[]; version: string }
export interface Progress { phase: string; detail: string; completed: number; total?: number }
export type ImportAction = 'overwrite' | 'skip' | 'keep-both';
export interface ImportDecision { itemId: string; action: ImportAction; targetId?: string }
export interface ImportItem { id: string; name: string; source: string; bytes: number; fileCount: number; matches: Snapshot[] }
export interface ImportPlan { id: string; gameId: string; directory: string; items: ImportItem[]; failed: { name: string; error: string }[] }
export interface ImportReport { imported: string[]; overwritten: string[]; keptBoth: string[]; skipped: string[]; failed: { name: string; error: string }[] }
export interface BatchReport { updated: string[]; failed: { id: string; label: string; error: string }[] }
export interface ExportResult { folder: string; count: number }
export interface Bridge {
  state(): Promise<AppState>;
  setTheme(theme: Theme): Promise<void>;
  saveGame(game: GameInput): Promise<string>;
  removeGame(id: string, undo?: boolean): Promise<void>;
  pickDirectory(): Promise<string | null>;
  pickIcon(): Promise<string | null>;
  saveSnapshot(id: string, details: { label: string; note: string }): Promise<Snapshot>;
  restoreSnapshot(gameId: string, id: string): Promise<{ safetyId: string; label: string }>;
  updateSnapshot(gameId: string, id: string, details: { label?: string; note?: string; favorite?: boolean; protected?: boolean; deleted?: boolean }): Promise<void>;
  updateSnapshots(gameId: string, ids: string[] | 'all', details: { deleted: boolean } | { protected: boolean }): Promise<BatchReport>;
  deleteSnapshots(gameId: string, ids: string[]): Promise<BatchReport>;
  verifySnapshot(gameId: string, id: string): Promise<{ fileCount: number; bytes: number }>;
  importSnapshots(id: string, useLegacy?: boolean): Promise<ImportPlan | null>;
  executeImport(planId: string, decisions: ImportDecision[]): Promise<ImportReport>;
  cancelImport(planId: string): Promise<void>;
  exportSnapshot(gameId: string, id: string): Promise<string | null>;
  exportSnapshots(gameId: string, ids: string[] | 'all'): Promise<ExportResult | null>;
  openFolder(kind: 'vault' | 'game' | 'snapshots', id?: string): Promise<void>;
  onProgress(callback: (progress: Progress | null) => void): () => void;
}
declare global { interface Window { savehub?: Bridge } }
