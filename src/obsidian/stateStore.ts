import type { DataAdapter } from "obsidian";
import { emptyState, type StateStore, type SyncState } from "../sync/types";

/**
 * Sync state lives in its own file next to the plugin (it can get large for
 * big vaults), written via temp file + rename so a crash never leaves a
 * half-written state behind.
 */
export class FileStateStore implements StateStore {
  private readonly tmp: string;
  constructor(private readonly adapter: DataAdapter, private readonly path: string) {
    this.tmp = `${path}.tmp`;
  }

  async load(): Promise<SyncState> {
    for (const p of [this.path, this.tmp]) {
      try {
        if (!(await this.adapter.exists(p))) continue;
        const s = JSON.parse(await this.adapter.read(p)) as SyncState;
        if (s.version === 1) return s;
      } catch {
        /* corrupt: try the next candidate */
      }
    }
    return emptyState();
  }

  async save(state: SyncState): Promise<void> {
    await this.adapter.write(this.tmp, JSON.stringify(state));
    if (await this.adapter.exists(this.path)) await this.adapter.remove(this.path);
    await this.adapter.rename(this.tmp, this.path);
  }

  async reset(): Promise<void> {
    for (const p of [this.path, this.tmp]) if (await this.adapter.exists(p)) await this.adapter.remove(p);
  }
}
