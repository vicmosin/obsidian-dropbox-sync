import { describe, expect, it } from "vitest";
import { DropboxApiError, DropboxClient, RemoteFolderMissingError } from "../src/dropbox/client";
import type { HttpRequest, HttpResponse } from "../src/dropbox/http";
import { RemoteConflictError } from "../src/sync/types";
import { buf } from "./fakes";

function res(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { status, headers, text, arrayBuffer: buf(text) };
}

function client(responses: HttpResponse[], log: HttpRequest[] = []) {
  let tokens = { accessToken: "old", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
  return new DropboxClient({
    appKey: "key",
    root: "/Obsidian/Diary",
    http: async (req) => {
      log.push(req);
      const r = responses.shift();
      if (!r) throw new Error(`unexpected request ${req.url}`);
      return r;
    },
    getTokens: () => tokens,
    saveTokens: async (t) => void (tokens = t),
    sleep: async () => {},
  });
}

describe("DropboxClient", () => {
  it("escapes non-ASCII paths in Dropbox-API-Arg", async () => {
    const log: HttpRequest[] = [];
    const meta = { ".tag": "file", path_display: "/Obsidian/Diary/Дневник.md", content_hash: "h", rev: "1", size: 1 };
    const c = client([res(200, "x", { "Dropbox-API-Result": JSON.stringify(meta) })], log);
    const { meta: m } = await c.download("Дневник.md");
    expect(m.path).toBe("Дневник.md");
    const arg = log[0]!.headers!["Dropbox-API-Arg"]!;
    expect(/^[\x00-\x7f]*$/.test(arg)).toBe(true);
    expect(JSON.parse(arg).path).toBe("/Obsidian/Diary/Дневник.md");
  });

  it("maps list_folder entries to vault-relative changes", async () => {
    const c = client([
      res(200, {
        entries: [
          { ".tag": "folder", path_display: "/Obsidian/Diary" },
          { ".tag": "file", path_display: "/Obsidian/Diary/a.md", content_hash: "h", rev: "1", size: 3 },
          { ".tag": "deleted", path_display: "/Obsidian/Diary/old" },
        ],
        cursor: "c1",
        has_more: false,
      }),
    ]);
    const r = await c.listChanges(null);
    expect(r.reset).toBe(true);
    expect(r.changes).toEqual([
      { type: "file", path: "a.md", hash: "h", rev: "1", size: 3 },
      { type: "deleted", path: "old" },
    ]);
  });

  it("falls back to a full listing when the cursor is reset", async () => {
    const c = client([
      res(409, { error_summary: "reset/..." }),
      res(200, { entries: [], cursor: "fresh", has_more: false }),
    ]);
    const r = await c.listChanges("stale");
    expect(r).toMatchObject({ reset: true, cursor: "fresh" });
  });

  it("refreshes an expired token once and retries", async () => {
    const log: HttpRequest[] = [];
    const c = client(
      [
        res(401, { error_summary: "expired_access_token/" }),
        res(200, { access_token: "new", expires_in: 14400 }),
        res(200, { entries: [], cursor: "c", has_more: false }),
      ],
      log,
    );
    await c.listChanges(null);
    expect(log[2]!.headers!.Authorization).toBe("Bearer new");
  });

  it("retries rate limits and server errors", async () => {
    const c = client([
      res(429, "too many", { "Retry-After": "1" }),
      res(503, "unavailable"),
      res(200, { entries: [], cursor: "c", has_more: false }),
    ]);
    await expect(c.listChanges(null)).resolves.toMatchObject({ cursor: "c" });
  });

  it("turns upload conflicts into RemoteConflictError and sends strict update mode", async () => {
    const log: HttpRequest[] = [];
    const c = client([res(409, { error_summary: "path/conflict/file/.." })], log);
    await expect(c.upload("a.md", buf("x"), "rev1")).rejects.toBeInstanceOf(RemoteConflictError);
    const arg = JSON.parse(log[0]!.headers!["Dropbox-API-Arg"]!);
    expect(arg).toMatchObject({ mode: { ".tag": "update", update: "rev1" }, strict_conflict: true, autorename: false });
  });

  it("treats deleting an already-deleted file as success", async () => {
    const c = client([res(409, { error_summary: "path_lookup/not_found/" })]);
    await expect(c.delete("a.md", "r")).resolves.toBeUndefined();
  });

  it("never creates a missing sync folder, it reports it", async () => {
    const log: HttpRequest[] = [];
    const c = client([res(409, { error_summary: "path/not_found/" })], log);
    await expect(c.listChanges(null)).rejects.toBeInstanceOf(RemoteFolderMissingError);
    expect(log.map((r) => r.url).some((u) => u.includes("create_folder"))).toBe(false);
  });

  it("creates a folder only when asked", async () => {
    const log: HttpRequest[] = [];
    const c = client([res(200, { metadata: { path_display: "/Obsidian/New" } })], log);
    expect(await c.createFolder("/Obsidian/New/")).toBe("/Obsidian/New");
    expect(JSON.parse(log[0]!.body as string)).toMatchObject({ path: "/Obsidian/New", autorename: false });
  });

  it("defers deletes Dropbox asks to retry, and surfaces other delete errors", async () => {
    const busy = client([res(409, { error_summary: "too_many_write_operations/" })]);
    await expect(busy.delete("a.md", "r")).rejects.toBeInstanceOf(RemoteConflictError);
    const changed = client([res(409, { error_summary: "path_write/conflict/file/" })]);
    await expect(changed.delete("a.md", "r")).rejects.toBeInstanceOf(RemoteConflictError);
    const restricted = client([res(409, { error_summary: "path_lookup/restricted_content/" })]);
    await expect(restricted.delete("a.md", "r")).rejects.toBeInstanceOf(DropboxApiError);
  });

  it("lists subfolders for the picker, paging and spotting vaults", async () => {
    const log: HttpRequest[] = [];
    const c = client(
      [
        res(200, {
          entries: [
            { ".tag": "folder", name: "Zebra", path_display: "/Notes/Zebra" },
            { ".tag": "file", name: "a.md", path_display: "/Notes/a.md" },
            { ".tag": "folder", name: ".obsidian", path_display: "/Notes/.obsidian" },
          ],
          cursor: "c1",
          has_more: true,
        }),
        res(200, { entries: [{ ".tag": "folder", name: "дневник", path_display: "/Notes/дневник" }], cursor: "c2", has_more: false }),
      ],
      log,
    );
    const l = await c.listFolder("/Notes/");
    expect(l).toEqual({
      path: "/Notes",
      isVault: true,
      folders: [
        { name: "Zebra", path: "/Notes/Zebra" },
        { name: "дневник", path: "/Notes/дневник" },
      ],
    });
    expect(JSON.parse(log[0]!.body as string)).toMatchObject({ path: "/Notes", recursive: false });
  });

  it("lists the Dropbox root with an empty path", async () => {
    const log: HttpRequest[] = [];
    const c = client([res(200, { entries: [], cursor: "c", has_more: false })], log);
    await c.listFolder("/");
    expect(JSON.parse(log[0]!.body as string).path).toBe("");
  });
});
