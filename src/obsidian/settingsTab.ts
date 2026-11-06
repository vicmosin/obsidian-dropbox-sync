import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type DropboxSyncPlugin from "../main";

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: DropboxSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName("Dropbox").setHeading();

    new Setting(containerEl)
      .setName("Dropbox app key")
      .setDesc("From your app at dropbox.com/developers/apps. See the README for setup.")
      .addText((t) =>
        t.setPlaceholder("abc123…").setValue(s.appKey).onChange(async (v) => {
          s.appKey = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    const connected = !!s.tokens;
    const account = new Setting(containerEl)
      .setName(connected ? `Connected${s.accountName ? `: ${s.accountName}` : ""}` : "Not connected");
    if (connected) {
      account.addButton((b) =>
        b.setButtonText("Disconnect").setWarning().onClick(async () => {
          await this.plugin.disconnect();
          this.display();
        }),
      );
    } else {
      account
        .setDesc("“Connect” returns to Obsidian automatically. If that does not work, use “Connect with code”.")
        .addButton((b) => b.setButtonText("Connect").setCta().onClick(() => this.plugin.startAuth(true)))
        .addButton((b) => b.setButtonText("Connect with code").onClick(() => this.plugin.startAuth(false)));
    }

    new Setting(containerEl)
      .setName("Dropbox folder")
      .setDesc("The Dropbox folder that holds this vault, e.g. /Obsidian/Diary. Changing it resets sync state.")
      .addText((t) =>
        t.setPlaceholder("/Obsidian/MyVault").setValue(s.remoteRoot).onChange(async (v) => {
          const next = v.trim();
          if (next === s.remoteRoot) return;
          s.remoteRoot = next;
          await this.plugin.saveSettings();
          await this.plugin.resetState(false);
        }),
      );

    new Setting(containerEl).setName("When to sync").setHeading();

    new Setting(containerEl)
      .setName("Mode")
      .setDesc("Manual: only when you tap the sync button. Automatic: on startup, on return to the app, after edits and periodically.")
      .addDropdown((d) =>
        d.addOption("manual", "Manual").addOption("auto", "Automatic").setValue(s.mode).onChange(async (v) => {
          s.mode = v as typeof s.mode;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (s.mode === "auto") {
      new Setting(containerEl).setName("Sync on startup and when returning to the app").addToggle((t) =>
        t.setValue(s.syncOnStartup).onChange(async (v) => {
          s.syncOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );
      new Setting(containerEl)
        .setName("Sync after edits (seconds)")
        .setDesc("Waits until you stop typing. 0 = off.")
        .addText((t) =>
          t.setValue(String(s.syncAfterEditSeconds)).onChange(async (v) => {
            s.syncAfterEditSeconds = Math.max(0, Number(v) || 0);
            await this.plugin.saveSettings();
          }),
        );
      new Setting(containerEl)
        .setName("Periodic sync (minutes)")
        .setDesc("0 = off.")
        .addText((t) =>
          t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
            s.intervalMinutes = Math.max(0, Number(v) || 0);
            await this.plugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl).setName("What to sync").setHeading();

    new Setting(containerEl)
      .setName(`Sync ${this.app.vault.configDir} folder`)
      .setDesc("Settings, themes and plugins. Off by default: phones and computers usually want different settings.")
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Excluded paths")
      .setDesc("One pattern per line. * matches within a folder, ** across folders; a folder pattern excludes its contents.")
      .addTextArea((t) => {
        t.setValue(s.excludes).onChange(async (v) => {
          s.excludes = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.rows = 6;
      });

    new Setting(containerEl).setName("Safety").setHeading();

    new Setting(containerEl)
      .setName("Ask before deleting more than")
      .setDesc("If one sync would delete more files than this, it stops and asks.")
      .addText((t) =>
        t.setValue(String(s.maxDeletes)).onChange(async (v) => {
          s.maxDeletes = Math.max(0, Number(v) || 0);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Device name")
      .setDesc("Used in conflict file names.")
      .addText((t) =>
        t.setValue(s.deviceLabel).onChange(async (v) => {
          s.deviceLabel = v.trim() || "device";
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc("Forgets what was synced before. Safe: identical files are matched by content, differing ones become conflicts, nothing is deleted.")
      .addButton((b) =>
        b.setButtonText("Reset").onClick(async () => {
          await this.plugin.resetState(true);
          new Notice("Sync state reset");
        }),
      );
  }
}
