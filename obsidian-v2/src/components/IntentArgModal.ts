import { App, Modal, Setting } from "obsidian";

/**
 * Single-input modal that resolves to the user's text or null if cancelled.
 * Replaces window.prompt(). Enter submits, Esc cancels, blank input cancels.
 */
export class IntentArgModal extends Modal {
	private readonly heading: string;
	private readonly placeholder: string;
	private readonly initial: string;
	private readonly resolve: (value: string | null) => void;
	private inputEl?: HTMLInputElement;

	constructor(
		app: App,
		heading: string,
		placeholder: string,
		initial: string,
		resolve: (value: string | null) => void,
	) {
		super(app);
		this.heading = heading;
		this.placeholder = placeholder;
		this.initial = initial;
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("aos-v2-cc-modal");
		contentEl.createEl("h2", { text: this.heading });

		const setting = new Setting(contentEl).addText((text) => {
			text.setPlaceholder(this.placeholder).setValue(this.initial);
			text.inputEl.style.width = "100%";
			this.inputEl = text.inputEl;
			this.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					e.preventDefault();
					this.submit();
				} else if (e.key === "Escape") {
					e.preventDefault();
					this.cancel();
				}
			});
		});
		setting.settingEl.style.borderTop = "none";

		const buttons = contentEl.createDiv({ cls: "aos-v2-cc-modal-buttons" });
		const submitBtn = buttons.createEl("button", {
			text: "Open workflow",
			cls: "mod-cta",
		});
		submitBtn.onclick = () => this.submit();
		const cancelBtn = buttons.createEl("button", { text: "Cancel" });
		cancelBtn.onclick = () => this.cancel();

		// focus + select existing content for easy overwrite
		setTimeout(() => {
			this.inputEl?.focus();
			this.inputEl?.select();
		}, 30);
	}

	private submit(): void {
		const v = (this.inputEl?.value || "").trim();
		this.resolve(v.length > 0 ? v : null);
		this.close();
	}

	private cancel(): void {
		this.resolve(null);
		this.close();
	}

	onClose(): void {
        this.resolve(null);
		this.contentEl.empty();
	}
}

/** Convenience promise wrapper. */
export function askForArg(
	app: App,
	heading: string,
	placeholder: string,
	initial = "",
): Promise<string | null> {
	return new Promise((resolve) => {
		new IntentArgModal(app, heading, placeholder, initial, resolve).open();
	});
}
