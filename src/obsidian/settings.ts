import { Platform } from "obsidian";
import type { Tokens } from "../dropbox/auth";

export type SyncMode = "auto" | "manual";

/**
 * App key of the public "Synced Up" Dropbox app. It is an identifier, not a
 * secret: sign-in uses PKCE, so no app secret exists in the plugin, and only
 * the person who signs in can grant access to their Dropbox.
 */
export const BUILTIN_APP_KEY = "y5zectn7a6juslx";

export interface Settings {
  /** Custom Dropbox app key; empty = use BUILTIN_APP_KEY. */
  appKey: string;
  /** Dropbox folder mirrored to this vault, e.g. "/Obsidian/Diary". */
  remoteRoot: string;
  mode: SyncMode;
  intervalMinutes: number;
  syncOnStartup: boolean;
  /** Seconds after the last edit before an auto sync; 0 disables. */
  syncAfterEditSeconds: number;
  syncConfigDir: boolean;
  excludes: string;
  maxDeletes: number;
  deviceLabel: string;
  tokens: Tokens | null;
  accountName: string;
  lastSync: number;
}

function defaultDeviceLabel(): string {
  if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
  if (Platform.isAndroidApp) return "Android";
  return "Desktop";
}

export const DEFAULT_SETTINGS: Settings = {
  appKey: "",
  remoteRoot: "",
  mode: "manual",
  intervalMinutes: 10,
  syncOnStartup: true,
  syncAfterEditSeconds: 30,
  syncConfigDir: false,
  excludes: [".trash/", ".DS_Store", "Thumbs.db", "*.tmp", "*.icloud"].join("\n"),
  maxDeletes: 25,
  deviceLabel: defaultDeviceLabel(),
  tokens: null,
  accountName: "",
  lastSync: 0,
};
