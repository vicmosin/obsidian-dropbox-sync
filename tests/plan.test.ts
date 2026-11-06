import { describe, expect, it } from "vitest";
import { decide } from "../src/sync/plan";

describe("decide (L, R, B)", () => {
  const cases: [string | undefined, string | undefined, string | undefined, string | null][] = [
    // in sync
    ["a", "a", "a", null],
    [undefined, undefined, undefined, null],
    // first sync, identical content → just record base, no transfer
    ["a", "a", undefined, "adopt"],
    // both converged to new content
    ["b", "b", "a", "adopt"],
    // gone everywhere
    [undefined, undefined, "a", "forget"],
    // one-sided changes
    ["a", "b", "a", "pull"],
    [undefined, "a", undefined, "pull"],
    ["a", undefined, "a", "deleteLocal"],
    ["b", "a", "a", "push"],
    ["a", undefined, undefined, "push"],
    [undefined, "a", "a", "deleteRemote"],
    // both changed
    ["b", "c", "a", "conflict"],
    ["b", "c", undefined, "conflict"],
    // edit beats delete
    [undefined, "b", "a", "pull"],
    ["b", undefined, "a", "push"],
  ];
  it.each(cases)("L=%s R=%s B=%s → %s", (L, R, B, want) => {
    expect(decide(L, R, B)).toBe(want);
  });
});
