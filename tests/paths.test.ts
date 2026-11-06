import { describe, expect, it } from "vitest";
import { conflictPath, fromRemotePath, pathKey, PathFilter, toRemotePath } from "../src/sync/paths";

describe("paths", () => {
  it("treats NFD and NFC Cyrillic names as the same file", () => {
    const nfd = "Дневник/Мой день.md".normalize("NFD");
    expect(nfd).not.toBe("Дневник/Мой день.md");
    expect(pathKey(nfd)).toBe(pathKey("дневник/мой день.md"));
  });
  it("maps between remote and vault paths", () => {
    expect(toRemotePath("/Obsidian/Diary/", "a/b.md")).toBe("/Obsidian/Diary/a/b.md");
    expect(toRemotePath("", "a.md")).toBe("/a.md");
    expect(fromRemotePath("/Obsidian/Diary", "/obsidian/diary/A/b.md")).toBe("A/b.md");
    expect(fromRemotePath("/Obsidian/Diary", "/Obsidian/Other/x.md")).toBeNull();
    expect(fromRemotePath("/Obsidian/Diary", "/Obsidian/DiaryX/x.md")).toBeNull();
  });
  it("builds conflict names", () => {
    expect(conflictPath("a/Note.md", new Date(2026, 10, 6, 9, 5), "iPhone")).toBe(
      "a/Note (conflict iPhone 2026-11-06 0905).md",
    );
  });
  it("filters with globs", () => {
    const f = new PathFilter([".trash/", ".obsidian/workspace*.json", "*.tmp", "# comment", ".DS_Store"]);
    expect(f.excluded(".trash/old.md")).toBe(true);
    expect(f.excluded(".obsidian/workspace-mobile.json")).toBe(true);
    expect(f.excluded(".obsidian/app.json")).toBe(false);
    expect(f.excluded("deep/x.tmp")).toBe(true);
    expect(f.excluded("sub/.DS_Store")).toBe(true);
    expect(f.excluded("notes/today.md")).toBe(false);
  });
});
