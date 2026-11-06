import { App, Modal, Setting } from "obsidian";
import type { FolderListing } from "../dropbox/client";

export interface FolderSource {
  listFolder(absPath: string): Promise<FolderListing>;
}

/** Browse Dropbox folders and pick the one that holds the vault. */
export class FolderPickerModal extends Modal {
  private path: string;
  private loading = 0;

  constructor(
    app: App,
    private readonly source: FolderSource,
    start: string,
    private readonly onPick: (path: string) => void,
  ) {
    super(app);
    this.path = start.replace(/\/+$/, "");
  }

  onOpen(): void {
    this.setTitle("Choose Dropbox folder");
    void this.show(this.path, true);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async show(path: string, fallbackToRoot = false): Promise<void> {
    const token = ++this.loading;
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: "Loading…", cls: "synced-up-muted" });
    let listing: FolderListing;
    try {
      listing = await this.source.listFolder(path);
    } catch (e) {
      if (token !== this.loading) return;
      // The saved folder may have been moved or deleted: start from the root.
      if (fallbackToRoot && path) return this.show("");
      contentEl.empty();
      contentEl.createEl("p", { text: `Could not open folder: ${e instanceof Error ? e.message : String(e)}` });
      new Setting(contentEl).addButton((b) => b.setButtonText("Back to root").onClick(() => void this.show("")));
      return;
    }
    if (token !== this.loading) return; // a newer navigation won
    this.path = listing.path;
    this.render(listing);
  }

  private render(listing: FolderListing): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("p", {
      text: "Tap a folder name to open it. Tap Select next to the folder that holds your vault.",
      cls: "synced-up-muted",
    });
    contentEl.createEl("div", { text: listing.path || "/ (Dropbox root)", cls: "synced-up-picker-path" });
    if (listing.isVault) {
      contentEl.createEl("div", { text: "✓ You are inside an Obsidian vault", cls: "synced-up-picker-vault" });
    }

    const list = contentEl.createEl("div", { cls: "synced-up-picker-list" });
    if (listing.path) {
      const up = listing.path.slice(0, listing.path.lastIndexOf("/"));
      this.row(list, "⬆  Back", () => void this.show(up), null);
    }
    if (listing.folders.length === 0) {
      list.createEl("div", { text: "No subfolders", cls: "synced-up-muted synced-up-picker-row" });
    }
    for (const f of listing.folders) {
      this.row(list, `📁  ${f.name}`, () => void this.show(f.path), () => this.pick(f.path));
    }

    const name = listing.path ? listing.path.slice(listing.path.lastIndexOf("/") + 1) : "Dropbox root";
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText(`Select “${name}”`).setCta().onClick(() => this.pick(listing.path)));
  }

  private pick(path: string): void {
    this.close();
    this.onPick(path);
  }

  private row(parent: HTMLElement, text: string, onOpen: () => void, onSelect: (() => void) | null): void {
    const el = parent.createEl("div", { cls: "synced-up-picker-row" });
    const label = el.createEl("span", { text, cls: "synced-up-picker-name" });
    label.setAttr("role", "button");
    label.setAttr("tabindex", "0");
    label.addEventListener("click", onOpen);
    label.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onOpen();
    });
    if (onSelect) {
      const btn = el.createEl("button", { text: "Select" });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        onSelect();
      });
    }
  }
}
