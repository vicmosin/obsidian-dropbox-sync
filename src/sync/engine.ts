import { dropboxContentHash } from "./hash";
import { conflictPath, pathKey, PathFilter } from "./paths";
import { plan, summarize, type Action, type PlanSummary } from "./plan";
import { mapLimit } from "./pool";
import {
  emptyState,
  RemoteConflictError,
  type LocalFs,
  type RemoteFs,
  type RemoteMeta,
  type StateStore,
  type SyncState,
} from "./types";

export interface EngineOptions {
  /** Dropbox folder being synced; state saved for another folder is ignored. */
  root?: string;
  filter: PathFilter;
  /** Used in conflict file names, e.g. "iPhone". */
  deviceLabel: string;
  /** Abort (unless confirmed) when a run would delete more files than this. */
  maxDeletes: number;
  log: (msg: string) => void;
  onProgress?: (msg: string) => void;
  now?: () => Date;
  /** Save state after this many actions; keeps interrupted runs cheap. */
  checkpointEvery?: number;
}

export interface RunOptions {
  dryRun?: boolean;
  allowMassDelete?: boolean;
}

export interface SyncResult {
  actions: Action[];
  summary: PlanSummary;
  errors: { path: string; message: string }[];
  /** Skipped because something changed while we were syncing; retried next run. */
  deferred: string[];
  aborted?: string;
}

/**
 * Recompute every key from the stored path, so state written by a version
 * with different key rules (or by hand) still lines up. Last entry wins.
 */
function rekey(state: SyncState): SyncState {
  const fix = <T extends { path: string }>(m: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const v of Object.values(m)) out[pathKey(v.path)] = v;
    return out;
  };
  return { ...state, remote: fix(state.remote), base: fix(state.base), local: fix(state.local) };
}

type LocalStatLike = { path: string; mtime: number; size: number };

/** Files read and hashed in parallel during a scan (each read is a native call on mobile). */
const HASH_CONCURRENCY = 8;

/** Thrown internally when a file changed under us mid-sync. */
class Deferred extends Error {}

export class SyncEngine {
  private running = false;

  constructor(
    private readonly local: LocalFs,
    private readonly remote: RemoteFs,
    private readonly store: StateStore,
    private readonly opts: EngineOptions,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(run: RunOptions = {}): Promise<SyncResult> {
    if (this.running) throw new Error("Sync already running");
    this.running = true;
    try {
      return await this.runInner(run);
    } finally {
      this.running = false;
    }
  }

  private async runInner(run: RunOptions): Promise<SyncResult> {
    const { log, filter } = this.opts;
    const progress = this.opts.onProgress ?? (() => {});
    const state = await this.loadState();

    progress("Fetching remote changes…");
    await this.pullRemoteIndex(state);
    await this.store.save(state);

    progress("Scanning vault…");
    const { files: local, ambiguous } = await this.scanLocal(state);
    await this.store.save(state);

    // Keys with several local files are left alone entirely: dropping only
    // the local side would read as "deleted here" and delete it in Dropbox.
    const keep = (k: string, path: string) => !ambiguous.has(k) && !filter.excluded(path);
    const remote = new Map<string, RemoteMeta>();
    for (const [k, m] of Object.entries(state.remote)) if (keep(k, m.path)) remote.set(k, m);
    const base = new Map<string, { path: string; hash: string }>();
    for (const [k, b] of Object.entries(state.base)) if (keep(k, b.path)) base.set(k, b);

    const actions = plan({ local, remote, base });
    const summary = summarize(actions);
    const result: SyncResult = { actions, summary, errors: [], deferred: [] };
    log(`Plan: ${JSON.stringify(summary)}`);
    if (run.dryRun) return result;

    const deletes = summary.deleteLocal + summary.deleteRemote;
    if (local.size === 0 && summary.deleteRemote > 0 && !run.allowMassDelete) {
      result.aborted = "The vault looks empty but was synced before. Refusing to delete everything remotely.";
      return result;
    }
    if (deletes > this.opts.maxDeletes && !run.allowMassDelete) {
      result.aborted = `This sync would delete ${deletes} files (limit ${this.opts.maxDeletes}).`;
      return result;
    }

    const every = this.opts.checkpointEvery ?? 20;
    let done = 0;
    const work = actions.filter((a) => a.kind !== "adopt" && a.kind !== "forget");
    for (const a of actions) {
      try {
        await this.execute(a, state, local);
      } catch (e) {
        const path = "path" in a ? a.path : a.key;
        if (e instanceof Deferred || e instanceof RemoteConflictError) {
          result.deferred.push(path);
          log(`Deferred ${a.kind} ${path}: ${(e as Error).message}`);
        } else {
          const message = e instanceof Error ? e.message : String(e);
          result.errors.push({ path, message });
          log(`ERROR ${a.kind} ${path}: ${message}`);
        }
      }
      if (a.kind !== "adopt" && a.kind !== "forget") {
        done++;
        progress(`Syncing ${done}/${work.length}`);
        if (done % every === 0) await this.store.save(state);
      }
    }
    await this.store.save(state);
    return result;
  }

  private async loadState(): Promise<SyncState> {
    const state = rekey(await this.store.load());
    const root = this.opts.root;
    if (root === undefined) return state;
    if (state.root === undefined) {
      // Written before states remembered their folder; it was reset on every
      // folder change, so it belongs to the current one.
      state.root = root;
    } else if (state.root !== root) {
      this.opts.log(`Ignoring sync state saved for ${state.root}; starting fresh for ${root}`);
      return emptyState(root);
    }
    return state;
  }

  /** Bring the remote index up to date using Dropbox's incremental cursor. */
  private async pullRemoteIndex(state: SyncState): Promise<void> {
    let cursor = state.cursor;
    let fresh: Record<string, RemoteMeta> | null = null;
    for (;;) {
      const page = await this.remote.listChanges(cursor);
      if (page.reset) fresh = {};
      const index = fresh ?? state.remote;
      for (const c of page.changes) {
        const key = pathKey(c.path);
        if (c.type === "file") {
          index[key] = { path: c.path, hash: c.hash, rev: c.rev, size: c.size };
        } else if (c.type === "deleted") {
          delete index[key];
          const prefix = key + "/";
          for (const k of Object.keys(index)) if (k.startsWith(prefix)) delete index[k];
        }
      }
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    if (fresh) state.remote = fresh;
    state.cursor = cursor;
  }

  /**
   * List local files and hash those whose mtime/size changed. Keys shared by
   * several local files (names differing only in case or space kind) are
   * reported as ambiguous and not synced.
   */
  private async scanLocal(
    state: SyncState,
  ): Promise<{ files: Map<string, { path: string; hash: string }>; ambiguous: Set<string> }> {
    const { filter, log } = this.opts;
    const byKey = new Map<string, LocalStatLike[]>();
    for (const f of await this.local.list()) {
      if (filter.excluded(f.path)) continue;
      const key = pathKey(f.path);
      byKey.set(key, [...(byKey.get(key) ?? []), f]);
    }
    const ambiguous = new Set<string>();
    const unique: [string, LocalStatLike][] = [];
    for (const [key, list] of byKey) {
      if (list.length > 1) {
        ambiguous.add(key);
        log(`Not syncing ${list.map((f) => f.path).join(" / ")}: names differ only in letter case or space type. Rename one of them.`);
      } else unique.push([key, list[0]!]);
    }

    const stale = unique.filter(([key, f]) => {
      const c = state.local[key];
      return !c || c.mtime !== f.mtime || c.size !== f.size || c.path !== f.path;
    });
    let hashed = 0;
    await mapLimit(stale, HASH_CONCURRENCY, async ([key, f]) => {
      const hash = await dropboxContentHash(await this.local.read(f.path));
      state.local[key] = { path: f.path, mtime: f.mtime, size: f.size, hash };
      if (++hashed % 50 === 0) this.opts.onProgress?.(`Hashed ${hashed}/${stale.length} changed files…`);
    });

    const files = new Map<string, { path: string; hash: string }>();
    for (const [key, f] of unique) files.set(key, { path: f.path, hash: state.local[key]!.hash });
    for (const k of Object.keys(state.local)) if (!files.has(k)) delete state.local[k];
    return { files, ambiguous };
  }

  /** Guard against the user editing a file while we sync it. */
  private async assertLocalUnchanged(state: SyncState, key: string, path: string): Promise<void> {
    const st = await this.local.stat(path);
    const cached = state.local[key];
    if (!st && !cached) return;
    if (!st || !cached || st.mtime !== cached.mtime || st.size !== cached.size) {
      throw new Deferred("local file changed during sync");
    }
  }

  private async execute(a: Action, state: SyncState, local: Map<string, { path: string; hash: string }>) {
    switch (a.kind) {
      case "adopt":
        state.base[a.key] = { path: a.path, hash: a.hash };
        return;
      case "forget":
        delete state.base[a.key];
        return;
      case "pull":
        await this.assertLocalUnchanged(state, a.key, local.get(a.key)?.path ?? a.path);
        await this.doPull(state, a.key, a.path);
        return;
      case "push":
        await this.doPush(state, a.key, a.path, local.get(a.key)!.hash);
        return;
      case "deleteLocal":
        await this.assertLocalUnchanged(state, a.key, a.path);
        await this.local.remove(a.path);
        delete state.local[a.key];
        delete state.base[a.key];
        this.opts.log(`Deleted locally ${a.path}`);
        return;
      case "deleteRemote": {
        const meta = state.remote[a.key];
        if (meta) await this.remote.delete(meta.path, meta.rev);
        delete state.remote[a.key];
        delete state.base[a.key];
        this.opts.log(`Deleted remotely ${a.path}`);
        return;
      }
      case "conflict": {
        await this.assertLocalUnchanged(state, a.key, a.path);
        const copy = conflictPath(a.path, (this.opts.now ?? (() => new Date()))(), this.opts.deviceLabel);
        const copyKey = pathKey(copy);
        await this.local.rename(a.path, copy);
        const cached = state.local[a.key]!;
        delete state.local[a.key];
        state.local[copyKey] = { ...cached, path: copy };
        this.opts.log(`Conflict on ${a.path}: local version kept as ${copy}`);
        await this.doPull(state, a.key, state.remote[a.key]!.path);
        await this.doPush(state, copyKey, copy, cached.hash);
        return;
      }
    }
  }

  private async doPull(state: SyncState, key: string, path: string): Promise<void> {
    const { data, meta } = await this.remote.download(path);
    const hash = await dropboxContentHash(data);
    if (hash !== meta.hash) throw new Error("downloaded content does not match Dropbox content hash");
    const st = await this.local.write(meta.path, data);
    state.local[key] = { path: st.path, mtime: st.mtime, size: st.size, hash };
    state.remote[key] = meta;
    state.base[key] = { path: meta.path, hash };
    this.opts.log(`Pulled ${meta.path}`);
  }

  private async doPush(state: SyncState, key: string, path: string, expectedHash: string): Promise<void> {
    const data = await this.local.read(path);
    const hash = await dropboxContentHash(data);
    if (hash !== expectedHash) throw new Deferred("local file changed during sync");
    // Update the Dropbox file under its own name: the local name can differ
    // (e.g. Obsidian replaced non-breaking spaces), and uploading under the
    // local name would create a second file next to it.
    const existing = state.remote[key];
    const meta = await this.remote.upload(existing?.path ?? path, data, existing?.rev ?? null);
    if (meta.hash !== hash) throw new Error("Dropbox stored different content than we sent");
    state.remote[key] = meta;
    state.base[key] = { path, hash };
    this.opts.log(`Pushed ${path}`);
  }
}
