/**
 * Dropbox content hash: SHA-256 of the concatenated SHA-256 digests of each
 * 4 MiB block. https://www.dropbox.com/developers/reference/content-hash
 *
 * Computing it locally lets us compare content instead of modification times,
 * which iOS and the Dropbox desktop client both change freely.
 */
const BLOCK = 4 * 1024 * 1024;

export async function dropboxContentHash(data: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const n = Math.max(1, Math.ceil(data.byteLength / BLOCK));
  const blocks = data.byteLength === 0 ? 0 : n;
  const concat = new Uint8Array(blocks * 32);
  for (let i = 0; i < blocks; i++) {
    const d = await subtle.digest("SHA-256", data.slice(i * BLOCK, Math.min((i + 1) * BLOCK, data.byteLength)));
    concat.set(new Uint8Array(d), i * 32);
  }
  return toHex(await subtle.digest("SHA-256", concat));
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}
