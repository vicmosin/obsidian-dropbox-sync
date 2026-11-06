import { dropboxContentHash } from "../src/sync/hash";
import { pathKey } from "../src/sync/paths";
import {
  emptyState,
  RemoteConflictError,
  type LocalFs,
  type LocalStat,
  type RemoteChange,
  type RemoteChanges,
  type RemoteFs,
  type RemoteMeta,
  type StateStore,
  type SyncState,
} from "../src/sync/types";

const enc = new TextEncoder();
const dec = new TextDecoder();
export const buf = (s: string): ArrayBuffer => enc.encode(s).buffer as ArrayBuffer;
export const str = (b: ArrayBuffer): string => dec.decode(b);

/** In-memory Dropbox with revisions and an incremental change log. */
export class FakeDropbox implements RemoteFs {
  files = new Map<string, { path: string; data: ArrayBuffer; rev: string; hash: string }>();
  private log: RemoteChange[] = [];
  private revs = 0;
  pageSize = 3;
  calls = { download: 0, upload: 0, delete: 0 };

  /** Simulates the Mac Dropbox client writing a file. */
  async put(path: string, text: string): Promise<void> {
    const data = buf(text);
    const hash = await dropboxContentHash(data);
    const rev = `r${++this.revs}`;
    this.files.set(pathKey(path), { path, data, rev, hash });
    this.log.push({ type: "file", path, hash, rev, size: data.byteLength });
  }
  remove(path: string): void {
    this.files.delete(pathKey(path));
    this.log.push({ type: "deleted", path });
  }
  text(path: string): string | undefined {
    const f = this.files.get(pathKey(path));
    return f && str(f.data);
  }
  paths(): string[] {
    return [...this.files.values()].map((f) => f.path).sort();
  }

  async listChanges(cursor: string | null): Promise<RemoteChanges> {
    if (cursor === null || cursor.startsWith("full:")) {
      // Full listing, paginated.
      const all: RemoteChange[] = [...this.files.values()].map((f) => ({
        type: "file", path: f.path, hash: f.hash, rev: f.rev, size: f.data.byteLength,
      }));
      const [, offStr, endStr] = (cursor ?? `full:0:${this.log.length}`).split(":");
      const off = Number(offStr);
      const page = all.slice(off, off + this.pageSize);
      const hasMore = off + this.pageSize < all.length;
      return {
        changes: page,
        cursor: hasMore ? `full:${off + this.pageSize}:${endStr}` : `${endStr}`,
        reset: cursor === null,
        hasMore,
      };
    }
    const from = Number(cursor);
    const changes = this.log.slice(from, from + this.pageSize);
    const next = from + changes.length;
    return { changes, cursor: String(next), reset: false, hasMore: next < this.log.length };
  }

  async download(path: string) {
    this.calls.download++;
    const f = this.files.get(pathKey(path));
    if (!f) throw new Error(`not found: ${path}`);
    return { data: f.data.slice(0), meta: this.meta(f) };
  }

  async upload(path: string, data: ArrayBuffer, rev: string | null): Promise<RemoteMeta> {
    this.calls.upload++;
    const key = pathKey(path);
    const existing = this.files.get(key);
    if (rev === null ? existing : existing?.rev !== rev) throw new RemoteConflictError(path);
    const hash = await dropboxContentHash(data);
    const f = { path: existing?.path ?? path, data: data.slice(0), rev: `r${++this.revs}`, hash };
    this.files.set(key, f);
    this.log.push({ type: "file", path: f.path, hash, rev: f.rev, size: data.byteLength });
    return this.meta(f);
  }

  async delete(path: string, rev: string): Promise<void> {
    this.calls.delete++;
    const f = this.files.get(pathKey(path));
    if (!f || f.rev !== rev) throw new RemoteConflictError(path);
    this.remove(path);
  }

  private meta(f: { path: string; data: ArrayBuffer; rev: string; hash: string }): RemoteMeta {
    return { path: f.path, hash: f.hash, rev: f.rev, size: f.data.byteLength };
  }
}

/** In-memory vault with a monotonic clock for mtimes. */
export class FakeVault implements LocalFs {
  files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  trash: string[] = [];
  private clock = 1000;
  /** Hook to simulate the user typing mid-sync. */
  onRead?: (path: string) => void;

  set(path: string, text: string): void {
    this.files.set(path, { data: buf(text), mtime: ++this.clock });
  }
  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f && str(f.data);
  }
  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async list(): Promise<LocalStat[]> {
    return [...this.files].map(([path, f]) => ({ path, mtime: f.mtime, size: f.data.byteLength }));
  }
  async read(path: string): Promise<ArrayBuffer> {
    this.onRead?.(path);
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT ${path}`);
    return f.data.slice(0);
  }
  async write(path: string, data: ArrayBuffer): Promise<LocalStat> {
    const f = { data: data.slice(0), mtime: ++this.clock };
    this.files.set(path, f);
    return { path, mtime: f.mtime, size: data.byteLength };
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.trash.push(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(from)!;
    this.files.delete(from);
    this.files.set(to, f);
  }
  async stat(path: string): Promise<LocalStat | null> {
    const f = this.files.get(path);
    return f ? { path, mtime: f.mtime, size: f.data.byteLength } : null;
  }
}

export class MemoryStore implements StateStore {
  state: SyncState = emptyState();
  saves = 0;
  async load(): Promise<SyncState> {
    return structuredClone(this.state);
  }
  async save(s: SyncState): Promise<void> {
    this.saves++;
    this.state = structuredClone(s);
  }
}
