/**
 * The heart of the sync: a pure three-way decision per file.
 *
 *   L = local content hash, R = remote content hash,
 *   B = hash both sides agreed on at the last sync (undefined = never synced)
 *
 * Nothing here touches I/O, so every rule is covered by unit tests.
 */
import type { RemoteMeta } from "./types";

export type Action =
  /** Same content on both sides; just record it as the new base. */
  | { kind: "adopt"; key: string; path: string; hash: string }
  /** Gone on both sides; drop the base entry. */
  | { kind: "forget"; key: string }
  | { kind: "pull"; key: string; path: string }
  | { kind: "push"; key: string; path: string }
  | { kind: "deleteLocal"; key: string; path: string }
  | { kind: "deleteRemote"; key: string; path: string }
  /** Both sides changed differently: keep both versions. */
  | { kind: "conflict"; key: string; path: string };

export interface PlanInput {
  local: Map<string, { path: string; hash: string }>;
  remote: Map<string, RemoteMeta>;
  base: Map<string, { path: string; hash: string }>;
}

export function decide(
  L: string | undefined,
  R: string | undefined,
  B: string | undefined,
): Action["kind"] | null {
  if (L === R) {
    if (L === undefined) return B === undefined ? null : "forget";
    return L === B ? null : "adopt";
  }
  if (L === B) return R === undefined ? "deleteLocal" : "pull";
  if (R === B) return L === undefined ? "deleteRemote" : "push";
  // Both sides changed. An edit always wins over a deletion.
  if (L === undefined) return "pull";
  if (R === undefined) return "push";
  return "conflict";
}

export function plan({ local, remote, base }: PlanInput): Action[] {
  const keys = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  const actions: Action[] = [];
  for (const key of [...keys].sort()) {
    const l = local.get(key);
    const r = remote.get(key);
    const b = base.get(key);
    const kind = decide(l?.hash, r?.hash, b?.hash);
    if (!kind) continue;
    const path = l?.path ?? r?.path ?? b?.path ?? key;
    switch (kind) {
      case "forget":
        actions.push({ kind, key });
        break;
      case "adopt":
        actions.push({ kind, key, path, hash: l!.hash });
        break;
      case "pull":
        actions.push({ kind, key, path: r!.path });
        break;
      default:
        actions.push({ kind, key, path });
    }
  }
  return actions;
}

export interface PlanSummary {
  pull: number;
  push: number;
  deleteLocal: number;
  deleteRemote: number;
  conflict: number;
  adopt: number;
}

export function summarize(actions: Action[]): PlanSummary {
  const s: PlanSummary = { pull: 0, push: 0, deleteLocal: 0, deleteRemote: 0, conflict: 0, adopt: 0 };
  for (const a of actions) if (a.kind !== "forget") s[a.kind]++;
  return s;
}
