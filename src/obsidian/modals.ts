import { App, Modal, Notice, Setting } from "obsidian";
import type { Action } from "../sync/plan";

const LABELS: Record<Action["kind"], string> = {
  pull: "⬇ Download",
  push: "⬆ Upload",
  deleteLocal: "🗑 Delete on this device",
  deleteRemote: "🗑 Delete in Dropbox",
  conflict: "⚠ Conflict (keep both)",
  adopt: "✓ Already identical",
  forget: "",
};

export class PlanModal extends Modal {
  constructor(app: App, private readonly actions: Action[], private readonly onRun?: () => void) {
    super(app);
  }
  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Sync preview");
    const shown = this.actions.filter((a) => a.kind !== "forget" && a.kind !== "adopt");
    if (shown.length === 0) contentEl.createEl("p", { text: "Everything is in sync." });
    const groups = new Map<Action["kind"], string[]>();
    for (const a of shown) {
      if (!("path" in a)) continue;
      groups.set(a.kind, [...(groups.get(a.kind) ?? []), a.path]);
    }
    for (const [kind, paths] of groups) {
      const details = contentEl.createEl("details", { attr: paths.length <= 10 ? { open: "" } : {} });
      details.createEl("summary", { text: `${LABELS[kind]} — ${paths.length}` });
      const ul = details.createEl("ul");
      for (const p of paths.slice(0, 500)) ul.createEl("li", { text: p });
      if (paths.length > 500) ul.createEl("li", { text: `…and ${paths.length - 500} more` });
    }
    if (this.onRun && shown.length > 0) {
      new Setting(contentEl).addButton((b) =>
        b.setButtonText("Sync now").setCta().onClick(() => {
          this.close();
          this.onRun!();
        }),
      );
    }
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly onConfirm: () => void,
    private readonly onPreview?: () => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.setTitle(this.title);
    this.contentEl.createEl("p", { text: this.message });
    const s = new Setting(this.contentEl);
    if (this.onPreview) s.addButton((b) => b.setButtonText("Show details").onClick(() => { this.close(); this.onPreview!(); }));
    s.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
    s.addButton((b) =>
      b.setButtonText(this.confirmText).setWarning().onClick(() => {
        this.close();
        this.onConfirm();
      }),
    );
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

export class LogModal extends Modal {
  constructor(app: App, private readonly lines: string[]) {
    super(app);
  }
  onOpen(): void {
    this.setTitle("Dropbox sync log");
    const text = this.lines.join("\n") || "(empty)";
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Copy").onClick(async () => {
        await navigator.clipboard.writeText(text);
        new Notice("Log copied");
      }),
    );
    const pre = this.contentEl.createEl("pre", { text });
    pre.style.whiteSpace = "pre-wrap";
    pre.style.fontSize = "0.8em";
    pre.style.userSelect = "text";
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

export class CodeModal extends Modal {
  private code = "";
  constructor(app: App, private readonly onSubmit: (code: string) => void) {
    super(app);
  }
  onOpen(): void {
    this.setTitle("Paste Dropbox code");
    this.contentEl.createEl("p", { text: "After allowing access, Dropbox shows a code. Paste it here." });
    new Setting(this.contentEl).setName("Code").addText((t) => t.onChange((v) => (this.code = v)));
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("Connect").setCta().onClick(() => {
        this.close();
        this.onSubmit(this.code);
      }),
    );
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
