import { ItemView, WorkspaceLeaf } from "obsidian";
import { render, h } from "preact";
import { Cockpit } from "./components/Cockpit";
import type ChaseCommandCenter from "./main";

export const COCKPIT_VIEW_TYPE = "agentic-os-v2";

export class CockpitView extends ItemView {
	plugin: ChaseCommandCenter;
	private mountEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ChaseCommandCenter) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return COCKPIT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Agentic OS V2";
	}

	getIcon(): string {
		return "activity";
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("aos-v2-cc-root");
		this.mountEl = container.createDiv({ cls: "aos-v2-cc-mount" });
		this.applyTheme();
		render(h(Cockpit, { plugin: this.plugin }), this.mountEl);
	}

	/** Stamp appearance preferences on the actual native view root. */
	applyTheme() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.setAttribute("data-cc-theme", this.plugin.settings.theme);
		container.setAttribute("data-paused", this.plugin.settings.pauseMotion ? "true" : "false");
		container.setAttribute(
			"data-cheap",
			this.plugin.settings.reduceBlur ? "true" : "false",
		);
		// The Glass component also carries this flag; update it immediately in both directions.
		container.querySelector('.v2-dashboard')?.setAttribute('data-cheap', String(this.plugin.settings.reduceBlur));
	}

	async onClose() {
		if (this.mountEl) {
			render(null, this.mountEl);
			this.mountEl = null;
		}
	}
}
