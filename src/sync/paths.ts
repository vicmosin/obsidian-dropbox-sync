/**
 * Path helpers.
 *
 * Every file is identified by a *key*: its vault-relative path, Unicode-NFC
 * normalized and lower-cased. Dropbox is case-insensitive and macOS/iOS hand
 * out NFD-decomposed names (Cyrillic "й"/"ё", accented Latin), so comparing
 * raw strings produces phantom "new" files and duplicates.
 *
 * Obsidian also rewrites non-breaking spaces (U+00A0, U+202F) to plain
 * spaces whenever it writes a file, so a Dropbox file named with them comes
 * back from the vault under a slightly different name. Keys treat them as
 * plain spaces too, or such files look deleted on one side and new on the
 * other.
 */

export function normalizePath(path: string): string {
  return path
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/|\/$/g, "");
}

export function pathKey(path: string): string {
  return normalizePath(path).replace(/\u00A0|\u202F/g, " ").toLowerCase();
}

/** Join the remote root ("/Obsidian/Diary") with a vault-relative path. */
export function toRemotePath(root: string, rel: string): string {
  const r = normalizePath(root);
  const p = normalizePath(rel);
  return "/" + (r ? `${r}/${p}` : p);
}

/**
 * Turn a Dropbox path (display or lower) into a vault-relative path, or null
 * if it lies outside the root.
 */
export function fromRemotePath(root: string, remote: string): string | null {
  const r = pathKey(root);
  const p = normalizePath(remote);
  if (!r) return p;
  const pk = p.toLowerCase();
  if (pk === r) return "";
  if (!pk.startsWith(r + "/")) return null;
  return p.slice(r.length + 1);
}

export function conflictPath(path: string, date: Date, label: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}${pad(date.getMinutes())}`;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${dir}${base} (conflict ${label} ${stamp})${ext}`;
}

/** Minimal glob: `*` (no slash), `**` (anything), `?`. Matching a folder excludes its contents. */
export function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob.trim());
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern without a slash matches the name at any depth; a match on a
  // folder also covers everything inside it.
  const anyDepth = !g.includes("/") ? "(?:.*/)?" : "";
  return new RegExp(`^${anyDepth}${re}(?:/.*)?$`, "i");
}

export class PathFilter {
  private readonly res: RegExp[];
  constructor(patterns: string[]) {
    this.res = patterns.map((p) => p.trim()).filter((p) => p && !p.startsWith("#")).map(globToRegExp);
  }
  excluded(path: string): boolean {
    const p = normalizePath(path);
    return this.res.some((r) => r.test(p));
  }
}
