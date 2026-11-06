import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dropboxContentHash } from "../src/sync/hash";

function reference(data: Buffer): string {
  const BLOCK = 4 * 1024 * 1024;
  const outer = createHash("sha256");
  for (let i = 0; i < data.length; i += BLOCK) {
    outer.update(createHash("sha256").update(data.subarray(i, i + BLOCK)).digest());
  }
  return outer.digest("hex");
}

describe("dropboxContentHash", () => {
  it("hashes an empty file", async () => {
    expect(await dropboxContentHash(new ArrayBuffer(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it.each([1, 4 * 1024 * 1024, 4 * 1024 * 1024 + 1, 9 * 1024 * 1024 + 17])("matches reference for %i bytes", async (n) => {
    const data = Buffer.alloc(n);
    for (let i = 0; i < n; i++) data[i] = (i * 31 + 7) & 0xff;
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + n) as ArrayBuffer;
    expect(await dropboxContentHash(ab)).toBe(reference(data));
  });
});
