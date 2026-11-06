export interface RemoteMeta {
  /** vault-relative display path */
  path: string;
  hash: string;
  rev: string;
  size: number;
}

export type RemoteChange =
  | ({ type: "file" } & RemoteMeta)
  | { type: "folder"; path: string }
  | { type: "deleted"; path: string };

export interface RemoteChanges {
  changes: RemoteChange[];
  cursor: string;
  /** True when this batch is a full listing and the index must be rebuilt. */
  reset: boolean;
  hasMore: boolean;
}

export interface LocalStat {
  path: string;
  mtime: number;
  size: number;
}

/** Thrown when the remote revision no longer matches what we expected. */
export class RemoteConflictError extends Error {
  constructor(public readonly path: string, detail?: string) {
    super(`Remote changed concurrently: ${path}${detail ? ` (${detail})` : ""}`);
  }
}

export interface RemoteFs {
  /** cursor=null → full listing from scratch. Paths are vault-relative. */
  listChanges(cursor: string | null): Promise<RemoteChanges>;
  download(path: string): Promise<{ data: ArrayBuffer; meta: RemoteMeta }>;
  /** rev=null → must not exist yet; otherwise must still be at `rev`. */
  upload(path: string, data: ArrayBuffer, rev: string | null): Promise<RemoteMeta>;
  delete(path: string, rev: string): Promise<void>;
}

export interface LocalFs {
  /** All files (not folders) in the vault, including hidden ones. */
  list(): Promise<LocalStat[]>;
  read(path: string): Promise<ArrayBuffer>;
  write(path: string, data: ArrayBuffer): Promise<LocalStat>;
  /** Moves to trash where possible. */
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<LocalStat | null>;
}

export interface SyncState {
  version: 1;
  cursor: string | null;
  /** Remote index maintained from Dropbox deltas, by key. */
  remote: Record<string, RemoteMeta>;
  /** Content hash both sides agreed on at the last successful sync, by key. */
  base: Record<string, { path: string; hash: string }>;
  /** Local hash cache keyed by key; reused while mtime+size are unchanged. */
  local: Record<string, { path: string; mtime: number; size: number; hash: string }>;
}

export function emptyState(): SyncState {
  return { version: 1, cursor: null, remote: {}, base: {}, local: {} };
}

export interface StateStore {
  load(): Promise<SyncState>;
  save(state: SyncState): Promise<void>;
}
