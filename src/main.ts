import { debounce, Notice, Platform, Plugin, type ObsidianProtocolData } from "obsidian";
import { authorizeUrl, createPkce, exchangeCode } from "./dropbox/auth";
import { DropboxClient } from "./dropbox/client";
import { obsidianHttp } from "./obsidian/http";
import { ObsidianLocalFs } from "./obsidian/localFs";
import { CodeModal, ConfirmModal, LogModal, PlanModal } from "./obsidian/modals";
import { DEFAULT_SETTINGS, type Settings } from "./obsidian/settings";
import { SettingsTab } from "./obsidian/settingsTab";
import { FileStateStore } from "./obsidian/stateStore";
import { SyncEngine, type SyncResult } from "./sync/engine";
import { PathFilter } from "./sync/paths";

type Trigger = "manual" | "auto";
const MAX_LOG_LINES = 1000;
/** Don't auto-sync more often than this (resume + edit events can pile up). */
const MIN_AUTO_GAP_MS = 20_000;

export default class DropboxSyncPlugin extends Plugin {
  settings!: Settings;
  private engine: SyncEngine | null = null;
  private store!: FileStateStore;
  private logLines: string[] = [];
  private statusEl: HTMLElement | null = null;
  private ribbonEl: HTMLElement | null = null;
  private intervalId: number | null = null;
  private pendingAuth: { verifier: string; redirect: boolean } | null = null;
  private lastAutoSync = 0;
  private editDebounce: (() => void) | null = null;
  private retryTimer: number | null = null;

  private get pluginDir(): string {
    return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.store = new FileStateStore(this.app.vault.adapter, `${this.pluginDir}/sync-state.json`);

    this.ribbonEl = this.addRibbonIcon("refresh-cw", "Sync with Dropbox", () => void this.sync("manual"));
    if (!Platform.isMobile) this.statusEl = this.addStatusBarItem();
    this.setStatus(this.settings.lastSync ? `Dropbox: synced ${timeAgo(this.settings.lastSync)}` : "Dropbox: idle");

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync("manual") });
    this.addCommand({ id: "preview", name: "Preview sync (dry run)", callback: () => void this.preview() });
    this.addCommand({ id: "show-log", name: "Show sync log", callback: () => new LogModal(this.app, this.logLines).open() });

    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerObsidianProtocolHandler("dropbox-vault-sync-auth", (p) => void this.finishAuth(p));

    // Automatic triggers. Each checks the mode itself, so switching modes needs no re-registration.
    this.app.workspace.onLayoutReady(() => {
      if (this.isAuto() && this.settings.syncOnStartup) void this.sync("auto");
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible" && this.isAuto() && this.settings.syncOnStartup) void this.sync("auto");
    });
    const onEdit = () => {
      if (!this.isAuto() || this.engine?.isRunning || !this.settings.syncAfterEditSeconds) return;
      this.editDebounce?.();
    };
    this.registerEvent(this.app.vault.on("modify", onEdit));
    this.registerEvent(this.app.vault.on("create", onEdit));
    this.registerEvent(this.app.vault.on("delete", onEdit));
    this.registerEvent(this.app.vault.on("rename", onEdit));
    this.applySchedule();
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
  }

  // ---- settings ---------------------------------------------------------

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.engine = null; // rebuilt with new settings on next sync
    this.applySchedule();
  }

  private applySchedule(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    const s = this.settings;
    if (s.mode === "auto" && s.intervalMinutes > 0) {
      this.intervalId = window.setInterval(() => void this.sync("auto"), s.intervalMinutes * 60_000);
      this.registerInterval(this.intervalId);
    }
    this.editDebounce =
      s.syncAfterEditSeconds > 0 ? debounce(() => void this.sync("auto"), s.syncAfterEditSeconds * 1000, true) : null;
  }

  private isAuto(): boolean {
    return this.settings.mode === "auto" && !!this.settings.tokens;
  }

  // ---- auth -------------------------------------------------------------

  async startAuth(redirect: boolean): Promise<void> {
    if (!this.settings.appKey) {
      new Notice("Enter your Dropbox app key first.");
      return;
    }
    const { verifier, challenge } = await createPkce();
    this.pendingAuth = { verifier, redirect };
    window.open(authorizeUrl(this.settings.appKey, challenge, redirect));
    if (!redirect) new CodeModal(this.app, (code) => void this.completeAuth(code)).open();
  }

  private async finishAuth(params: ObsidianProtocolData): Promise<void> {
    if (params.error) {
      new Notice(`Dropbox: ${params.error_description ?? params.error}`);
      return;
    }
    if (params.code) await this.completeAuth(params.code);
  }

  private async completeAuth(code: string): Promise<void> {
    const pending = this.pendingAuth;
    if (!pending) {
      new Notice("Dropbox: no sign-in in progress. Start again from settings.");
      return;
    }
    try {
      this.settings.tokens = await exchangeCode(obsidianHttp, this.settings.appKey, code, pending.verifier, pending.redirect);
      this.pendingAuth = null;
      const account = await this.client().currentAccount();
      this.settings.accountName = `${account.name} (${account.email})`;
      await this.saveSettings();
      new Notice(`Connected to Dropbox as ${account.name}`);
      this.log(`Connected as ${account.email}`);
    } catch (e) {
      new Notice(`Dropbox sign-in failed: ${errMsg(e)}`);
      this.log(`Sign-in failed: ${errMsg(e)}`);
    }
  }

  async disconnect(): Promise<void> {
    this.settings.tokens = null;
    this.settings.accountName = "";
    await this.saveSettings();
  }

  // ---- sync -------------------------------------------------------------

  async resetState(notify: boolean): Promise<void> {
    await this.store.reset();
    this.log("Sync state reset");
    if (notify) new Notice("Next sync will compare all files by content.");
  }

  private client(): DropboxClient {
    return new DropboxClient({
      http: obsidianHttp,
      appKey: this.settings.appKey,
      root: this.settings.remoteRoot,
      getTokens: () => this.settings.tokens,
      saveTokens: async (t) => {
        this.settings.tokens = t;
        await this.saveData(this.settings);
      },
    });
  }

  private getEngine(): SyncEngine {
    if (this.engine) return this.engine;
    const s = this.settings;
    const cfg = this.app.vault.configDir;
    const patterns = s.excludes.split("\n");
    // Never sync our own state/tokens or per-device workspace layout.
    patterns.push(`${this.pluginDir}/`, `${cfg}/workspace.json`, `${cfg}/workspace-mobile.json`);
    if (!s.syncConfigDir) patterns.push(`${cfg}/`);
    const filter = new PathFilter(patterns);
    this.engine = new SyncEngine(new ObsidianLocalFs(this.app.vault.adapter, (p) => filter.excluded(p)), this.client(), this.store, {
      filter,
      deviceLabel: s.deviceLabel,
      maxDeletes: s.maxDeletes,
      log: (m) => this.log(m),
      onProgress: (m) => this.setStatus(`Dropbox: ${m}`),
    });
    return this.engine;
  }

  private ready(trigger: Trigger): boolean {
    if (!this.settings.tokens) {
      if (trigger === "manual") new Notice("Connect to Dropbox in the plugin settings first.");
      return false;
    }
    return true;
  }

  async preview(): Promise<void> {
    if (!this.ready("manual")) return;
    const engine = this.getEngine();
    if (engine.isRunning) return void new Notice("Sync is already running.");
    try {
      const r = await engine.run({ dryRun: true });
      new PlanModal(this.app, r.actions, () => void this.sync("manual", true)).open();
    } catch (e) {
      new Notice(`Dropbox preview failed: ${errMsg(e)}`);
    } finally {
      this.setStatus("Dropbox: idle");
    }
  }

  async sync(trigger: Trigger, allowMassDelete = false): Promise<void> {
    if (!this.ready(trigger)) return;
    const engine = this.getEngine();
    if (engine.isRunning) {
      if (trigger === "manual") new Notice("Sync is already running.");
      return;
    }
    if (trigger === "auto") {
      const wait = this.lastAutoSync + MIN_AUTO_GAP_MS - Date.now();
      if (wait > 0) {
        // Too soon after the previous run: try once more when the gap is over.
        if (this.retryTimer === null) {
          this.retryTimer = window.setTimeout(() => {
            this.retryTimer = null;
            void this.sync("auto");
          }, wait);
        }
        return;
      }
      this.lastAutoSync = Date.now();
    }
    this.ribbonEl?.addClass("is-syncing");
    this.log(`--- ${trigger} sync started`);
    let result: SyncResult;
    try {
      result = await engine.run({ allowMassDelete });
    } catch (e) {
      this.log(`Sync failed: ${errMsg(e)}`);
      this.setStatus("Dropbox: failed");
      if (trigger === "manual" || !isOffline(e)) new Notice(`Dropbox sync failed: ${errMsg(e)}`);
      return;
    } finally {
      this.ribbonEl?.removeClass("is-syncing");
      await this.flushLog();
    }
    this.report(trigger, result);
  }

  private report(trigger: Trigger, r: SyncResult): void {
    if (r.aborted) {
      this.log(`Aborted: ${r.aborted}`);
      this.setStatus("Dropbox: waiting for confirmation");
      new ConfirmModal(
        this.app,
        "Sync paused",
        `${r.aborted} Nothing was changed. Continue only if you meant to delete these files.`,
        "Delete and sync",
        () => void this.sync("manual", true),
        () => new PlanModal(this.app, r.actions).open(),
      ).open();
      return;
    }
    this.settings.lastSync = Date.now();
    void this.saveData(this.settings);
    const s = r.summary;
    const parts = [
      s.pull && `${s.pull}↓`,
      s.push && `${s.push}↑`,
      s.deleteLocal + s.deleteRemote && `${s.deleteLocal + s.deleteRemote} deleted`,
      s.conflict && `${s.conflict} conflict${s.conflict > 1 ? "s" : ""}`,
    ].filter(Boolean);
    const text = parts.length ? parts.join(", ") : "up to date";
    this.setStatus(`Dropbox: ${r.errors.length ? `${r.errors.length} errors` : text}`);
    this.log(`Done: ${text}; errors ${r.errors.length}, deferred ${r.deferred.length}`);

    if (r.errors.length) {
      new Notice(`Dropbox: ${r.errors.length} file(s) failed. See “Show sync log”.\n${r.errors[0]!.path}: ${r.errors[0]!.message}`, 10_000);
    } else if (s.conflict) {
      new Notice(`Dropbox: ${s.conflict} conflict(s). Both versions were kept; look for “(conflict …)” files.`, 10_000);
    } else if (trigger === "manual") {
      new Notice(`Dropbox: ${text}`);
    }
  }

  // ---- log / status -----------------------------------------------------

  private log(msg: string): void {
    const line = `${new Date().toISOString()} ${msg}`;
    this.logLines.push(line);
    if (this.logLines.length > MAX_LOG_LINES) this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
    console.debug(`[dropbox-sync] ${msg}`);
  }

  private async flushLog(): Promise<void> {
    try {
      await this.app.vault.adapter.write(`${this.pluginDir}/sync-log.txt`, this.logLines.join("\n"));
    } catch {
      /* logging must never break sync */
    }
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isOffline(e: unknown): boolean {
  return /net::|network|offline|timed out|ERR_/i.test(errMsg(e));
}

function timeAgo(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(t).toLocaleDateString();
}
