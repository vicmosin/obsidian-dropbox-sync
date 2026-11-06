import { normalizePath as obsidianNormalize, type DataAdapter } from "obsidian";
import type { LocalFs, LocalStat } from "../sync/types";

/**
 * Vault access through the low-level adapter, so hidden folders like
 * .obsidian are visible too. Excluded folders are pruned while walking.
 */
export class ObsidianLocalFs implements LocalFs {
  constructor(
    private readonly adapter: DataAdapter,
    private readonly skip: (path: string) => boolean,
  ) {}

  async list(): Promise<LocalStat[]> {
    const out: LocalStat[] = [];
    const walk = async (dir: string): Promise<void> => {
      const { files, folders } = await this.adapter.list(dir);
      for (const f of files) {
        if (this.skip(f)) continue;
        const st = await this.adapter.stat(f);
        if (st?.type === "file") out.push({ path: f, mtime: st.mtime, size: st.size });
      }
      for (const d of folders) if (!this.skip(d)) await walk(d);
    };
    await walk("/");
    return out;
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(obsidianNormalize(path));
  }

  async write(path: string, data: ArrayBuffer): Promise<LocalStat> {
    const p = obsidianNormalize(path);
    await this.ensureParent(p);
    await this.adapter.writeBinary(p, data);
    const st = await this.adapter.stat(p);
    if (!st) throw new Error(`File vanished after write: ${p}`);
    return { path: p, mtime: st.mtime, size: st.size };
  }

  async remove(path: string): Promise<void> {
    const p = obsidianNormalize(path);
    if (!(await this.adapter.exists(p))) return;
    // Into the vault's .trash folder, never a hard delete.
    await this.adapter.trashLocal(p);
  }

  async rename(from: string, to: string): Promise<void> {
    const t = obsidianNormalize(to);
    await this.ensureParent(t);
    await this.adapter.rename(obsidianNormalize(from), t);
  }

  async stat(path: string): Promise<LocalStat | null> {
    const st = await this.adapter.stat(obsidianNormalize(path));
    return st?.type === "file" ? { path, mtime: st.mtime, size: st.size } : null;
  }

  private async ensureParent(path: string): Promise<void> {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!(await this.adapter.exists(cur))) await this.adapter.mkdir(cur);
    }
  }
}
