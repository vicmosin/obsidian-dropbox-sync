import { beforeEach, describe, expect, it } from "vitest";
import { SyncEngine } from "../src/sync/engine";
import { PathFilter } from "../src/sync/paths";
import { FakeDropbox, FakeVault, MemoryStore } from "./fakes";

let remote: FakeDropbox;
let vault: FakeVault;
let store: MemoryStore;
let engine: SyncEngine;
const logs: string[] = [];

function makeEngine(opts: Partial<ConstructorParameters<typeof SyncEngine>[3]> = {}) {
  return new SyncEngine(vault, remote, store, {
    filter: new PathFilter([".trash/"]),
    deviceLabel: "iPhone",
    maxDeletes: 10,
    log: (m) => logs.push(m),
    now: () => new Date(2026, 10, 6, 12, 0),
    ...opts,
  });
}

beforeEach(() => {
  remote = new FakeDropbox();
  vault = new FakeVault();
  store = new MemoryStore();
  logs.length = 0;
  engine = makeEngine();
});

describe("SyncEngine", () => {
  it("downloads a fresh vault, then has nothing to do", async () => {
    await remote.put("Diary/2026-11-05.md", "вчера");
    await remote.put("Diary/2026-11-06.md", "сегодня");
    await remote.put("img/a.png", "PNG");
    await remote.put("b.md", "b");

    const r1 = await engine.run();
    expect(r1.summary.pull).toBe(4);
    expect(vault.text("Diary/2026-11-06.md")).toBe("сегодня");

    const r2 = await engine.run();
    expect(r2.actions).toEqual([]);
  });

  it("adopts identical files on first sync without transferring them (e.g. vault copied by another app)", async () => {
    await remote.put("a.md", "same");
    vault.set("a.md", "same");
    const r = await engine.run();
    expect(r.summary).toMatchObject({ adopt: 1, pull: 0, push: 0, conflict: 0 });
    expect(remote.calls.download + remote.calls.upload).toBe(0);
  });

  it("pushes local edits and pulls remote edits", async () => {
    await remote.put("a.md", "1");
    await remote.put("b.md", "1");
    await engine.run();

    vault.set("a.md", "local edit");
    await remote.put("b.md", "mac edit");
    const r = await engine.run();
    expect(r.summary).toMatchObject({ push: 1, pull: 1, conflict: 0 });
    expect(remote.text("a.md")).toBe("local edit");
    expect(vault.text("b.md")).toBe("mac edit");
    expect((await engine.run()).actions).toEqual([]);
  });

  it("propagates deletions both ways, to the trash locally", async () => {
    await remote.put("a.md", "a");
    await remote.put("b.md", "b");
    await engine.run();

    await vault.remove("a.md");
    remote.remove("b.md");
    const r = await engine.run();
    expect(r.summary).toMatchObject({ deleteRemote: 1, deleteLocal: 1 });
    expect(remote.paths()).toEqual([]);
    expect(vault.paths()).toEqual([]);
    expect(vault.trash).toContain("b.md");
  });

  it("handles a remote folder deletion", async () => {
    await remote.put("F/a.md", "a");
    await remote.put("F/b.md", "b");
    await engine.run();
    remote.files.clear();
    remote.remove("F"); // Dropbox reports only the folder
    const r = await engine.run();
    expect(r.summary.deleteLocal).toBe(2);
  });

  it("keeps both versions on a real conflict", async () => {
    await remote.put("note.md", "base");
    await engine.run();

    vault.set("note.md", "phone");
    await remote.put("note.md", "mac");
    const r = await engine.run();
    expect(r.summary.conflict).toBe(1);
    const copy = "note (conflict iPhone 2026-11-06 1200).md";
    expect(vault.text("note.md")).toBe("mac");
    expect(vault.text(copy)).toBe("phone");
    expect(remote.text(copy)).toBe("phone");
    expect(remote.text("note.md")).toBe("mac");
    expect((await engine.run()).actions).toEqual([]);
  });

  it("does not report a conflict when both sides made the same change", async () => {
    await remote.put("n.md", "base");
    await engine.run();
    vault.set("n.md", "same");
    await remote.put("n.md", "same");
    const r = await engine.run();
    expect(r.summary).toMatchObject({ adopt: 1, conflict: 0 });
  });

  it("an edit wins over a deletion on the other side", async () => {
    await remote.put("n.md", "base");
    await engine.run();
    await vault.remove("n.md");
    await remote.put("n.md", "edited on mac");
    await engine.run();
    expect(vault.text("n.md")).toBe("edited on mac");
  });

  it("treats NFD-named remote files as the same as NFC local files", async () => {
    await remote.put("Йога.md".normalize("NFD"), "x");
    vault.set("Йога.md".normalize("NFC"), "x");
    const r = await engine.run();
    expect(r.summary).toMatchObject({ adopt: 1, pull: 0, push: 0 });
  });

  it("refuses mass deletion unless confirmed", async () => {
    for (let i = 0; i < 12; i++) await remote.put(`n${i}.md`, `${i}`);
    await engine.run();
    for (let i = 0; i < 12; i++) await vault.remove(`n${i}.md`);

    const r = await engine.run();
    expect(r.aborted).toBeDefined();
    expect(remote.paths()).toHaveLength(12);

    const r2 = await engine.run({ allowMassDelete: true });
    expect(r2.summary.deleteRemote).toBe(12);
    expect(remote.paths()).toHaveLength(0);
  });

  it("refuses to wipe Dropbox when the local vault is suddenly empty", async () => {
    await remote.put("a.md", "a");
    await engine.run();
    await vault.remove("a.md");
    const r = await engine.run();
    expect(r.aborted).toMatch(/empty/);
    expect(remote.paths()).toEqual(["a.md"]);
  });

  it("dry run changes nothing", async () => {
    await remote.put("a.md", "a");
    vault.set("b.md", "b");
    const r = await engine.run({ dryRun: true });
    expect(r.summary).toMatchObject({ pull: 1, push: 1 });
    expect(vault.paths()).toEqual(["b.md"]);
    expect(remote.paths()).toEqual(["a.md"]);
  });

  it("defers a push when the remote changed after we listed it", async () => {
    await remote.put("a.md", "1");
    await engine.run();
    vault.set("a.md", "phone");
    // Mac edits right after we fetched the remote index.
    vault.onRead = () => {
      vault.onRead = undefined;
      void remote.put("a.md", "mac");
    };
    const r = await engine.run();
    expect(r.deferred).toEqual(["a.md"]);
    expect(remote.text("a.md")).toBe("mac"); // nothing overwritten

    const r2 = await engine.run();
    expect(r2.summary.conflict).toBe(1);
    expect(vault.text("a.md")).toBe("mac");
  });

  it("recovers cleanly when interrupted midway", async () => {
    for (let i = 0; i < 10; i++) await remote.put(`n${i}.md`, `${i}`);
    let n = 0;
    const realDownload = remote.download.bind(remote);
    remote.download = async (p) => {
      if (++n === 6) throw new Error("app suspended");
      return realDownload(p);
    };
    const r = await engine.run();
    expect(r.errors).toHaveLength(1);
    remote.download = realDownload;

    const r2 = await engine.run();
    expect(r2.summary.pull).toBe(1);
    expect(vault.paths()).toHaveLength(10);
  });

  it("recovers when killed after writing files but before saving state", async () => {
    await remote.put("a.md", "a");
    store.save = async () => {}; // state never persisted
    await engine.run();
    store.save = MemoryStore.prototype.save.bind(store);

    const r = await engine.run();
    expect(r.summary).toMatchObject({ adopt: 1, pull: 0, push: 0, conflict: 0 });
  });

  it("ignores excluded paths", async () => {
    vault.set(".trash/old.md", "x");
    await remote.put(".trash/other.md", "y");
    const r = await engine.run();
    expect(r.actions).toEqual([]);
  });

  it("only re-hashes files whose mtime or size changed", async () => {
    vault.set("a.md", "a");
    vault.set("b.md", "b");
    await engine.run();
    const reads: string[] = [];
    vault.onRead = (p) => reads.push(p);
    vault.set("b.md", "bb");
    await engine.run();
    // b.md is read once for hashing and once for upload; a.md is never read.
    expect(reads.filter((p) => p === "a.md")).toEqual([]);
  });

  it("treats names with non-breaking spaces as the same file after Obsidian rewrites them", async () => {
    const name = "Archive/Девять граблей, на которые\u00A0я наступил.md";
    const milgram = "Archive/Милгрэма\u202F— Obedience.md";
    await remote.put(name, "текст");
    await remote.put(milgram, "m");
    await engine.run();
    // Obsidian stored them with plain spaces.
    expect(vault.paths()).toEqual(["Archive/Девять граблей, на которые я наступил.md", "Archive/Милгрэма — Obedience.md"]);

    vault.set("Temp.md", "new note");
    const r = await engine.run();
    expect(r.actions.map((a) => a.kind)).toEqual(["push"]);
    expect(r.summary).toMatchObject({ push: 1, deleteRemote: 0, deleteLocal: 0 });
    expect(remote.paths()).toContain(name);
  });

  it("updates the existing Dropbox file, keeping its non-breaking-space name", async () => {
    const name = "Note\u00A0A.md";
    await remote.put(name, "v1");
    await engine.run();
    vault.set("Note A.md", "v2");
    const r = await engine.run();
    expect(r.summary.push).toBe(1);
    expect(r.deferred).toEqual([]);
    expect(remote.paths()).toEqual([name]);
    expect(remote.text(name)).toBe("v2");
  });

  it("migrates state saved with older path keys", async () => {
    const name = "Note\u00A0B.md";
    await remote.put(name, "v1");
    await engine.run();
    // Simulate state written by a version whose keys kept the NBSP.
    const old = (k: string) => k.replace("note b.md", "note\u00A0b.md");
    for (const m of [store.state.remote, store.state.base, store.state.local] as Record<string, unknown>[]) {
      for (const k of Object.keys(m)) {
        const v = m[k];
        delete m[k];
        m[old(k)] = v;
      }
    }
    const r = await engine.run();
    expect(r.actions).toEqual([]);
  });

  it("leaves names that collide only by space type alone instead of deleting in Dropbox", async () => {
    await remote.put("Note A.md", "a");
    await engine.run();
    vault.set("Note\u00A0A.md", "copy from Files app"); // same key as "Note A.md"
    const r = await engine.run();
    expect(r.actions).toEqual([]);
    expect(remote.paths()).toEqual(["Note A.md"]);
    expect(logs.some((l) => l.includes("Not syncing"))).toBe(true);
  });

  it("ignores state saved for another Dropbox folder", async () => {
    const forA = makeEngine({ root: "/A" });
    await remote.put("a.md", "a");
    await forA.run();
    expect(store.state.root).toBe("/A");

    // A stale save for /A must not leak into /B (e.g. a sync that was still running).
    const otherRemote = new FakeDropbox();
    await otherRemote.put("b.md", "b");
    const forB = new SyncEngine(vault, otherRemote, store, {
      root: "/B",
      filter: new PathFilter([]),
      deviceLabel: "iPhone",
      maxDeletes: 10,
      log: (m) => logs.push(m),
    });
    const r = await forB.run({ dryRun: true });
    // Fresh state: a.md is only local (push), b.md only remote (pull); nothing is deleted.
    expect(r.summary).toMatchObject({ push: 1, pull: 1, deleteLocal: 0, deleteRemote: 0 });
  });

  it("adopts state written before it remembered its folder", async () => {
    await remote.put("a.md", "a");
    await engine.run();
    delete store.state.root;
    const r = await makeEngine({ root: "/A" }).run();
    expect(r.actions).toEqual([]);
    expect(store.state.root).toBe("/A");
  });
});
