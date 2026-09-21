import {SKILLS} from '../../shared/contract.mjs';
import { h } from "preact";
import { useState } from "preact/hooks";
import { Notice } from "obsidian";
import type ChaseCommandCenter from "../main";
import { useProvider } from "../lib/provider";
import { writeIntent } from "../lib/queue";
import { askForArg } from "./IntentArgModal";
import {openWorkflowPicker} from './WorkflowModal';

interface Props {
	plugin: ChaseCommandCenter;
	onSubmitted?: () => void;
}

export interface ButtonSpec {
	skill: string;
	label: string;
	prompt?: "topic" | "url";
	promptLabel?: string;
	placeholder?: string;
}

// exported: the glass console's key row renders this SAME list so the two
// themes never drift on which skills are runnable
const QUICK_SKILLS = ['plan-today','inbox-brief','morning-intel','metrics-pull','weekly-review','deep-research-chase','yt-pipeline','angle-brainstorm','outline-build','content-cascade'];
export const BUTTONS: ButtonSpec[] = QUICK_SKILLS.map(skill=>{const spec=SKILLS[skill]!;return {skill,label:spec.label,prompt:spec.arg as ButtonSpec['prompt']}});

export function ActionBar({ plugin, onSubmitted }: Props) {
	const providerState = useProvider(plugin.app);
	const [busy, setBusy] = useState(false);

	const fire = async (spec: ButtonSpec) => {
		if (busy) return;
		setBusy(true);
		try {
			let args: Record<string, string> = {};
			if (spec.prompt === "topic" || spec.prompt === "url") {
				const value = await askForArg(
					plugin.app,
					spec.promptLabel || spec.label,
					spec.placeholder || "",
				);
				if (!value) {
					new Notice("Cancelled.");
					return;
				}
				args[spec.prompt] = value;
			}
			await writeIntent(plugin.app, spec.skill, args);
			onSubmitted?.();
		} catch (e) {
			new Notice(`Could not start workflow: ${e}`);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div>
			<div style={{display:'flex',justifyContent:'flex-end',marginBottom:'8px'}}><button type="button" onClick={()=>openWorkflowPicker(plugin.app)} style={{fontSize:'11px'}}>More workflows…</button></div>
		<div className="aos-v2-cc-actionbar">
			{BUTTONS.map((b) => (
				<button
					key={b.skill}
					type="button"
					className="aos-v2-cc-action-btn"
					disabled={busy || (!SKILLS[b.skill]?.direct && !providerState.health?.providers[providerState.selection.provider]?.installed)}
					onClick={() => void fire(b)}
				>
					{b.label}
				</button>
			))}
		</div>
		</div>
	);
}
