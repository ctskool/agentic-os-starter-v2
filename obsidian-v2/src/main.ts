import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { assertTestVault,readSelection } from "./lib/provider";
import { h, render } from "preact";
import { CockpitView, COCKPIT_VIEW_TYPE } from "./view";
import { DEFAULT_SETTINGS, ChaseSettings, ChaseSettingTab } from "./settings";
import { OrbFloat } from "./components/OrbFloat";
import {WorkView,WORK_VIEW} from './work-view';
import {configureVoiceTransport} from './lib/v2-voice';
import {openWorkflowPicker} from './components/WorkflowModal';
import {nativeVoiceHeartbeat} from './lib/native-voice-heartbeat';
import {chooseWork,workTarget,setWorkProvider,workFeed,workRequest,isLiveTerminal,type WorkTask} from './lib/work';
import {NativeTerminalTabs,NATIVE_TERMINAL_VIEW,terminalConversation} from './lib/native-terminal';
import {NativeDirectHost} from './lib/native-direct-host';
import {v2VoiceTransport} from './lib/v2-voice';
import {retireEmptyLaunchers} from './lib/retire-legacy-launchers';
import {registerSkillReports} from './lib/queue';

export default class ChaseCommandCenter extends Plugin {
	settings!: ChaseSettings;
	readonly voiceHeartbeat = nativeVoiceHeartbeat;
	private orbEl: HTMLDivElement | null = null;
	private themeStyleEl: HTMLStyleElement | null = null;
    private workOpenQueue:Promise<unknown>=Promise.resolve();
    private openingWork=false;
    private nativeLayoutDepth=0;
    private nativeTerminals:NativeTerminalTabs|null=null;
    private nativeDirect:NativeDirectHost|null=null;

	async onload() {
		try { await assertTestVault(this.app); }
		catch { new Notice("Agentic OS V2 needs an installed V2 vault configuration. Run the V2 installer for this vault."); return; }
		await this.loadSettings();
        configureVoiceTransport(this.app,this.manifest.dir||`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
        registerSkillReports(this);
        // Terminal renders its own CLI directly. Only small control/status
        // messages use the bridge; its output is never polled by this host.
        if((this.app.vault.adapter as any).getBasePath){
            this.nativeDirect=new NativeDirectHost({app:this.app,request:async(path,body)=>{
                const response=await v2VoiceTransport(path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});
                if(response.status!==200)throw new Error(response.json?.error||'Native terminal service is unavailable.');return response.json;
            },createLeaf:()=>this.createWorkLeaf(),reveal:async leaf=>{await this.app.workspace.revealLeaf(leaf)},withLayout:operation=>this.withNativeLayout(operation),notice:message=>{new Notice(message)}});
            const timers=(globalThis as any).require?.('timers')||globalThis;
            let polling=false,closed=false;
            const tick=async()=>{if(polling||closed)return;polling=true;try{await this.nativeDirect?.sync()}catch{/* Voice/work requests report connection errors; an idle poll stays quiet. */}finally{polling=false}};
            const timer=timers.setInterval(tick,700);
            this.register(()=>{closed=true;timers.clearInterval(timer);this.nativeDirect?.dispose();this.nativeDirect=null});
            this.app.workspace.onLayoutReady(()=>void tick());
        }
        setWorkProvider((await readSelection(this.app)).provider);
		// user-approved (2026-08-14): un-block Google sign-in in the Web
		// Viewer — see fixWebviewerUserAgent() below
		// V2 does not alter the host web viewer or its authentication sessions.
		this.injectThemeAssets();
        this.registerView(WORK_VIEW,leaf=>new WorkView(leaf,this));
        this.addCommand({id:'toggle-voice-recording',name:'Start or send voice recording',callback:()=>{if(!this.settings.orbEnabled){this.settings.orbEnabled=true;this.remountOrb()}window.dispatchEvent(new Event('aos-toggle-voice'))}});
        this.addCommand({id:'open-agent-work',name:'Open terminals',callback:()=>void this.activateWork()});
        this.addCommand({id:'run-workflow',name:'Run a workflow…',callback:()=>openWorkflowPicker(this.app)});
        const showWork=(event:Event)=>void this.activateWork((event as CustomEvent<string[]>).detail||[],false);window.addEventListener('aos-open-work',showWork);this.register(()=>window.removeEventListener('aos-open-work',showWork));
        this.app.workspace.onLayoutReady(()=>this.registerEvent(this.app.workspace.on('active-leaf-change',leaf=>{
            if(this.openingWork||this.nativeLayoutDepth>0||!leaf)return;
            const target=terminalConversation(leaf);
            if(target)chooseWork(target.id,target.provider);
            else if(leaf.view instanceof WorkView&&leaf.view.taskId)chooseWork(leaf.view.taskId);
        })));

		this.registerView(
			COCKPIT_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new CockpitView(leaf, this),
		);

		this.addRibbonIcon("activity", "Open Agentic OS V2", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-command-center",
			name: "Open Agentic OS V2",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "toggle-jarvis-orb",
			name: "Toggle Jarvis orb",
			callback: async () => {
				this.settings.orbEnabled = !this.settings.orbEnabled;
				await this.saveSettings();
				this.remountOrb();
			},
		});

		this.addSettingTab(new ChaseSettingTab(this.app, this));

		// the orb floats over the whole workspace, not inside the cockpit
		// view — wait for layout so document.body is settled
		this.app.workspace.onLayoutReady(() => {retireEmptyLaunchers(this.app,WORK_VIEW);this.remountOrb()});
	}

	async onunload() {
		// Leaves are detached automatically when the plugin unloads.
		this.unmountOrb();
		this.themeStyleEl?.remove();
		this.themeStyleEl = null;
	}

	/**
	 * Glass-theme runtime assets: self-hosted fonts + the sky backdrop.
	 * A bare url() in styles.css cannot resolve from a plugin view, so the
	 * adapter-resolved paths are injected as @font-face rules and a CSS var
	 * (--aos-v2-sky) that styles.css consumes.
	 */
	private injectThemeAssets() {
		const dir = this.manifest.dir;
		if (!dir) return;
		const res = (rel: string) =>
			this.app.vault.adapter.getResourcePath(`${dir}/${rel}`);
		const face = (family: string, file: string, weight: number) =>
			`@font-face{font-family:'${family}';src:url("${res(`assets/fonts/${file}`)}") format('woff2');font-weight:${weight};font-style:normal;font-display:swap;}`;
		this.themeStyleEl?.remove();
		this.themeStyleEl = document.head.createEl("style");
		this.themeStyleEl.setText(
			[
				face("Space Grotesk", "space-grotesk-latin-400-normal.woff2", 400),
				face("Space Grotesk", "space-grotesk-latin-500-normal.woff2", 500),
				face("Space Grotesk", "space-grotesk-latin-600-normal.woff2", 600),
				face("IBM Plex Mono", "ibm-plex-mono-latin-400-normal.woff2", 400),
				face("IBM Plex Mono", "ibm-plex-mono-latin-500-normal.woff2", 500),
				`.aos-v2-cc-root{--aos-v2-sky:url("${res("assets/sky.png")}");}`,
			].join("\n"),
		);
	}

	/** push the current theme onto every open cockpit view root */
	applyTheme() {
		for (const leaf of this.app.workspace.getLeavesOfType(COCKPIT_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof CockpitView) view.applyTheme();
		}
	}

	/**
	 * Google's login front-end rejects the core Web Viewer's user agent
	 * (the obsidian/Electron tokens read as an embedded webview → the
	 * ServiceLogin "401 malformed" wall). Strip them from the webviewer
	 * session partition (persist:vault-<appId>) so "pull up my calendar"
	 * can actually sign in. Best-effort — desktop only, and harmless if
	 * the electron surface ever changes shape.
	 */
	private fixWebviewerUserAgent() {
		try {
			/* eslint-disable @typescript-eslint/no-explicit-any */
			const remote = (window as any).require?.("@electron/remote")
				?? (window as any).require?.("electron")?.remote;
			const appId = (this.app as any).appId;
			if (!remote?.session || !appId) return;
			const ses = remote.session.fromPartition(`persist:vault-${appId}`);
			const ua = ses
				.getUserAgent()
				.replace(/ ?obsidian\/[\d.]+/i, "")
				.replace(/ ?Electron\/[\d.]+/i, "");
			ses.setUserAgent(ua);
			/* eslint-enable @typescript-eslint/no-explicit-any */
		} catch {
			// never let UA cosmetics break plugin load
		}
	}

	/** (re)mount the floating voice orb on document.body per settings */
	remountOrb() {
		this.unmountOrb();
		if (!this.settings.orbEnabled) return;
		this.orbEl = document.body.createDiv({ cls: "aos-v2-cc-orb-root" });
		render(h(OrbFloat, { plugin: this }), this.orbEl);
	}

	private unmountOrb() {
		if (!this.orbEl) return;
		render(null, this.orbEl);
		this.orbEl.remove();
		this.orbEl = null;
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(COCKPIT_VIEW_TYPE)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: COCKPIT_VIEW_TYPE, active: true });
		}
		workspace.revealLeaf(leaf);
	}

    activateWork(ids:(string|null)[]=[],selectConversation=true){
        const requested=ids.length?[...new Set(ids)]:null;
        // Opening Terminals is navigation. Only an explicit [null] means New
        // terminal; a not-yet-loaded current map must never clear saved state.
        const selection=!requested||requested[0]===null?readSelection(this.app):null;
        void selection?.catch(()=>{}); // Report through the serialized operation below.
        const operation=this.workOpenQueue.then(async()=>{
            const workspace=this.app.workspace;
            const provider=selection?(await selection).provider:undefined;
            const native=this.nativeTerminals??=new NativeTerminalTabs(this.app,{pluginDir:this.manifest.dir||`${this.app.vault.configDir}/plugins/${this.manifest.id}`,readSnapshot:()=>workRequest('?summary=1'),notice:message=>{new Notice(message)}});
            let current:string|null=null;
            if(!requested){
                // A plain terminal remains available with the bridge offline.
                // Navigation to saved/stopped work must not restart an agent or
                // bring back the old task-launcher screen.
                const snapshot=workFeed.getSnapshot(),id=workTarget(provider);
                if(snapshot.tasks.some((task:WorkTask)=>task.id===id&&isLiveTerminal(task)))current=id;
            }
            const targets:(string|null)[]=requested||[current];
            this.openingWork=true;
            if(selectConversation&&requested)chooseWork(targets[0]??null,targets[0]===null?provider:undefined);
            try{
            let first:WorkspaceLeaf|undefined;
            for(const id of targets){
                if(!id){await native.openShell(Boolean(requested));continue}
                const leaves=workspace.getLeavesOfType(WORK_VIEW);
                const leaf=leaves.find(candidate=>candidate.view instanceof WorkView&&candidate.view.taskId===id);
                const task=workFeed.getSnapshot().tasks.find((candidate:WorkTask)=>candidate.id===id) as WorkTask|undefined;
                const attached=this.nativeDirect&&(task?.execution==='native'||!task)
                    ?await this.nativeDirect.open(id)
                    :await native.open(id,()=>this.createWorkLeaf(),selectConversation?leaf:undefined);
                if(attached===undefined)continue;
                if(attached)first??=attached;
            }
            if(first)await workspace.revealLeaf(first);
            }finally{this.openingWork=false}
        });
        this.workOpenQueue=operation.catch(error=>{new Notice(`Could not open terminal: ${String(error)}`)});
        return this.workOpenQueue;
    }

    private async withNativeLayout<T>(operation:()=>Promise<T>):Promise<T>{
        // Native process startup can take seconds. Only actual layout changes
        // suppress programmatic active-leaf events; user selection stays live
        // while the CLI starts or the host waits for bridge acknowledgements.
        this.nativeLayoutDepth++;
        try{return await operation()}finally{this.nativeLayoutDepth--}
    }

    private createWorkLeaf(){
        const workspace=this.app.workspace;
        const anchor=workspace.getLeavesOfType(NATIVE_TERMINAL_VIEW)[0]||workspace.getLeavesOfType(WORK_VIEW)[0];
        if(anchor){workspace.setActiveLeaf(anchor,{focus:false});return workspace.getLeaf('tab')}
        const dashboard=workspace.getLeavesOfType(COCKPIT_VIEW_TYPE)[0];if(dashboard)workspace.setActiveLeaf(dashboard,{focus:false});
        return workspace.getLeaf('split','horizontal');
    }

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ChaseSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
