import { normalizePath as obsidianNormalize, type DataAdapter } from "obsidian";
import { cleanSlashes as exact } from "../sync/paths";
import { mapLimit } from "../sync/pool";
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
      // Each stat is a native call on mobile: run several at once.
      const stats = await mapLimit(
        files.filter((f) => !this.skip(f)),
        8,
        async (f) => [f, await this.adapter.stat(f)] as const,
      );
      for (const [f, st] of stats) if (st?.type === "file") out.push({ path: f, mtime: st.mtime, size: st.size });
      for (const d of folders) if (!this.skip(d)) await walk(d);
    };
    await walk("/");
    return out;
  }

  // Existing files are addressed by their exact name: Obsidian's normalizePath
  // turns non-breaking spaces into plain ones, which would point elsewhere.
  read(path: string): Promise<ArrayBuffer> {
    return this.adapter.readBinary(exact(path));
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
    const p = exact(path);
    if (!(await this.adapter.exists(p))) return;
    // Into the vault's .trash folder, never a hard delete.
    await this.adapter.trashLocal(p);
    await this.removeEmptyParents(p);
  }

  /**
   * Drop folders left empty by a deletion, so a folder deleted in Dropbox
   * does not linger as an empty folder. Stops at the first non-empty one.
   */
  private async removeEmptyParents(path: string): Promise<void> {
    let dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    while (dir) {
      try {
        const { files, folders } = await this.adapter.list(dir);
        if (files.length || folders.length) return;
        await this.adapter.rmdir(dir, false);
      } catch {
        return; // best effort: an empty folder is harmless
      }
      dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")));
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const t = obsidianNormalize(to);
    await this.ensureParent(t);
    await this.adapter.rename(exact(from), t);
  }

  async stat(path: string): Promise<LocalStat | null> {
    const st = await this.adapter.stat(exact(path));
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
