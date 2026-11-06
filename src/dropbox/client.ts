import { fromRemotePath, toRemotePath } from "../sync/paths";
import { RemoteConflictError, type RemoteChange, type RemoteChanges, type RemoteFs, type RemoteMeta } from "../sync/types";
import { refreshTokens, type Tokens } from "./auth";
import { header, headerSafeJson, type HttpFn, type HttpRequest, type HttpResponse } from "./http";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
/** Files above this go through an upload session in CHUNK-sized pieces. */
const SINGLE_UPLOAD_LIMIT = 32 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024;

export interface FolderListing {
  /** "" for the Dropbox root */
  path: string;
  folders: { name: string; path: string }[];
  /** The folder contains .obsidian, so it is probably a vault. */
  isVault: boolean;
}

export class DropboxApiError extends Error {
  constructor(public readonly status: number, public readonly summary: string, endpoint: string) {
    super(`Dropbox ${endpoint} failed (${status}): ${summary}`);
  }
}

interface DbxEntry {
  ".tag": "file" | "folder" | "deleted";
  path_display?: string;
  path_lower?: string;
  content_hash?: string;
  rev?: string;
  size?: number;
}

export interface DropboxClientOptions {
  http: HttpFn;
  appKey: string;
  /** Dropbox folder that mirrors the vault, e.g. "/Obsidian/Diary"; "" = root. */
  root: string;
  getTokens: () => Tokens | null;
  saveTokens: (t: Tokens) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export class DropboxClient implements RemoteFs {
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private readonly o: DropboxClientOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // ---- RemoteFs ---------------------------------------------------------

  async listChanges(cursor: string | null): Promise<RemoteChanges> {
    if (cursor) {
      try {
        const j = await this.rpc("files/list_folder/continue", { cursor });
        return this.toChanges(j, false);
      } catch (e) {
        // Cursor expired or Dropbox asks us to start over.
        if (e instanceof DropboxApiError && e.summary.startsWith("reset")) return this.fullListing();
        throw e;
      }
    }
    return this.fullListing();
  }

  async download(path: string): Promise<{ data: ArrayBuffer; meta: RemoteMeta }> {
    const res = await this.call("files/download", {
      url: `${CONTENT}/files/download`,
      method: "POST",
      headers: { "Dropbox-API-Arg": headerSafeJson({ path: this.remotePath(path) }) },
    });
    const raw = header(res, "dropbox-api-result");
    if (!raw) throw new Error("Dropbox download returned no metadata");
    return { data: res.arrayBuffer, meta: this.toMeta(JSON.parse(raw) as DbxEntry) };
  }

  async upload(path: string, data: ArrayBuffer, rev: string | null): Promise<RemoteMeta> {
    const commit = {
      path: this.remotePath(path),
      mode: rev ? { ".tag": "update", update: rev } : { ".tag": "add" },
      autorename: false,
      mute: true,
      // Fail instead of silently overwriting if the file changed or was deleted meanwhile.
      strict_conflict: true,
    };
    try {
      if (data.byteLength <= SINGLE_UPLOAD_LIMIT) {
        const res = await this.content("files/upload", commit, data);
        return this.toMeta(JSON.parse(res.text) as DbxEntry);
      }
      return await this.uploadSession(commit, data);
    } catch (e) {
      if (e instanceof DropboxApiError && e.status === 409 && e.summary.includes("conflict")) {
        throw new RemoteConflictError(path, e.summary);
      }
      throw e;
    }
  }

  async delete(path: string, rev: string): Promise<void> {
    try {
      await this.rpc("files/delete_v2", { path: this.remotePath(path), parent_rev: rev });
    } catch (e) {
      if (e instanceof DropboxApiError && e.status === 409) {
        if (e.summary.includes("not_found")) return; // already gone
        throw new RemoteConflictError(path, e.summary);
      }
      throw e;
    }
  }

  /**
   * Immediate subfolders of an absolute Dropbox path ("" = root), for the
   * folder picker. Independent of the configured sync root.
   */
  async listFolder(absPath: string): Promise<FolderListing> {
    const path = absPath === "/" ? "" : absPath.replace(/\/+$/, "");
    const folders: { name: string; path: string }[] = [];
    let isVault = false;
    let page = (await this.rpc("files/list_folder", { path, recursive: false, include_deleted: false, limit: 2000 })) as {
      entries: (DbxEntry & { name: string })[];
      cursor: string;
      has_more: boolean;
    };
    for (;;) {
      for (const e of page.entries) {
        if (e[".tag"] !== "folder") continue;
        if (e.name === ".obsidian") isVault = true;
        else folders.push({ name: e.name, path: e.path_display ?? `${path}/${e.name}` });
      }
      if (!page.has_more) break;
      page = (await this.rpc("files/list_folder/continue", { cursor: page.cursor })) as typeof page;
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return { path, folders, isVault };
  }

  async currentAccount(): Promise<{ name: string; email: string }> {
    const j = (await this.rpc("users/get_current_account", null)) as { name: { display_name: string }; email: string };
    return { name: j.name.display_name, email: j.email };
  }

  // ---- internals --------------------------------------------------------

  private async fullListing(): Promise<RemoteChanges> {
    const root = this.rootArg();
    const arg = { path: root, recursive: true, include_deleted: false, limit: 2000 };
    try {
      return this.toChanges(await this.rpc("files/list_folder", arg), true);
    } catch (e) {
      if (root && e instanceof DropboxApiError && e.summary.startsWith("path/not_found")) {
        await this.rpc("files/create_folder_v2", { path: root, autorename: false });
        return this.toChanges(await this.rpc("files/list_folder", arg), true);
      }
      throw e;
    }
  }

  private toChanges(j: unknown, reset: boolean): RemoteChanges {
    const r = j as { entries: DbxEntry[]; cursor: string; has_more: boolean };
    const changes: RemoteChange[] = [];
    for (const e of r.entries) {
      const rel = fromRemotePath(this.o.root, e.path_display ?? e.path_lower ?? "");
      if (rel === null || rel === "") continue;
      if (e[".tag"] === "file") changes.push({ type: "file", ...this.toMeta(e) });
      else if (e[".tag"] === "folder") changes.push({ type: "folder", path: rel });
      else changes.push({ type: "deleted", path: rel });
    }
    return { changes, cursor: r.cursor, reset, hasMore: r.has_more };
  }

  private toMeta(e: DbxEntry): RemoteMeta {
    const rel = fromRemotePath(this.o.root, e.path_display ?? e.path_lower ?? "");
    if (rel === null) throw new Error(`Path outside sync folder: ${e.path_display}`);
    return { path: rel, hash: e.content_hash ?? "", rev: e.rev ?? "", size: e.size ?? 0 };
  }

  private async uploadSession(commit: object, data: ArrayBuffer): Promise<RemoteMeta> {
    const start = await this.content("files/upload_session/start", { close: false }, data.slice(0, CHUNK));
    const sessionId = (JSON.parse(start.text) as { session_id: string }).session_id;
    let offset = CHUNK;
    while (data.byteLength - offset > CHUNK) {
      await this.content("files/upload_session/append_v2", { cursor: { session_id: sessionId, offset } }, data.slice(offset, offset + CHUNK));
      offset += CHUNK;
    }
    const res = await this.content(
      "files/upload_session/finish",
      { cursor: { session_id: sessionId, offset }, commit },
      data.slice(offset),
    );
    return this.toMeta(JSON.parse(res.text) as DbxEntry);
  }

  private rootArg(): string {
    const r = toRemotePath(this.o.root, "x");
    return r === "/x" ? "" : r.slice(0, -2);
  }

  private remotePath(rel: string): string {
    return toRemotePath(this.o.root, rel);
  }

  private async rpc(endpoint: string, arg: unknown): Promise<unknown> {
    const res = await this.call(endpoint, {
      url: `${API}/${endpoint}`,
      method: "POST",
      contentType: "application/json",
      body: arg === null ? "null" : JSON.stringify(arg),
    });
    return res.text ? JSON.parse(res.text) : null;
  }

  private content(endpoint: string, arg: unknown, body: ArrayBuffer): Promise<HttpResponse> {
    return this.call(endpoint, {
      url: `${CONTENT}/${endpoint}`,
      method: "POST",
      contentType: "application/octet-stream",
      headers: { "Dropbox-API-Arg": headerSafeJson(arg) },
      body,
    });
  }

  /** Auth, token refresh, rate limiting and retries for every request. */
  private async call(endpoint: string, req: HttpRequest): Promise<HttpResponse> {
    const maxRetries = this.o.maxRetries ?? 5;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken(false);
      let res: HttpResponse;
      try {
        res = await this.o.http({ ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } });
      } catch (e) {
        // Network error (offline, app backgrounded): retry with backoff.
        if (attempt >= maxRetries) throw e;
        await this.sleep(backoff(attempt));
        continue;
      }
      if (res.status >= 200 && res.status < 300) return res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.accessToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(header(res, "retry-after"));
        await this.sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      let summary = res.text;
      try {
        summary = (JSON.parse(res.text) as { error_summary?: string }).error_summary ?? res.text;
      } catch {
        /* plain-text error */
      }
      throw new DropboxApiError(res.status, summary, endpoint);
    }
  }

  private async accessToken(forceRefresh: boolean): Promise<string> {
    let t = this.o.getTokens();
    if (!t) throw new Error("Not connected to Dropbox");
    if (forceRefresh || Date.now() > t.expiresAt - 5 * 60 * 1000) {
      t = await refreshTokens(this.o.http, this.o.appKey, t);
      await this.o.saveTokens(t);
    }
    return t.accessToken;
  }
}

function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
}
