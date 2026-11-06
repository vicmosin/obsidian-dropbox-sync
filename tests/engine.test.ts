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
});
