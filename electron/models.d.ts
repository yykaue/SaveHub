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

export interface FileRecord {
  path: string;
  type: 'file' | 'directory';
  mtimeMs: number;
  size?: number;
  sha256?: string;
}
export interface Inventory {
  records: FileRecord[];
  absent: string[];
}
export interface Manifest extends Snapshot, Inventory {
  version: 1;
  fingerprint: string;
  origin?: { path?: string; gameId?: string; snapshotId?: string };
}
export interface StoredGame extends GameInput {
  id: string;
  createdAt: string;
  deletedAt?: string;
  purgeGamePending?: boolean;
  purgeSnapshotsPending?: boolean;
  origin?: { gameId: string; path: string };
  importOrigin?: { id: string };
}
export interface LibraryConfig {
  version: number;
  games: StoredGame[];
  theme: Theme;
  language: Language;
  restorePointRetention: RestorePointRetention;
  maxRestorePoints?: number;
}
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
export interface ImportReplacementJournal {
  version: number;
  token: string;
  gameId: string;
  id: string;
  status: 'prepared' | 'committed';
}
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
