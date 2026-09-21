import type { App, TFile } from "obsidian";
import {Notice} from 'obsidian';
import {assertVoiceVault,v2VoiceTransport} from './v2-voice';
async function guardedModify(app:App,file:TFile,before:string,after:string){
 try{
 await assertVoiceVault(app);
 const r=await v2VoiceTransport('/notes/replace',{method:'POST',body:JSON.stringify({path:file.path,before,after})});
 if(r.status!==200)throw new Error(r.json?.error||'Note edit failed');
 return true;
 }catch(e){new Notice(String(e));return false}
}

/**
 * Toggle the first checkbox line whose visible text matches `text`
 * inside the section under `## <heading>`.
 *
 * Used by both `## Daily Drivers` (flat `- [ ]` checklist) and
 * `## Top 3 Priorities` (numbered `1. [ ]` list — see toggleTop3 below).
 */
export async function toggleTaskByText(
	app: App,
	path: string,
	heading: string,
	text: string,
): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!file || !("extension" in file)) return false;
	const tfile = file as TFile;
	const raw = await app.vault.read(tfile);
    const original = raw;

	const headingMarker = `## ${heading}`;
	const idx = raw.indexOf(headingMarker);
	if (idx < 0) return false;

	const afterHeading = idx + headingMarker.length;
	const nextSection = raw.indexOf("\n## ", afterHeading);
	const sectionStart = afterHeading;
	const sectionEnd = nextSection < 0 ? raw.length : nextSection;

	const before = raw.slice(0, sectionStart);
	const after = raw.slice(sectionEnd);
	const section = raw.slice(sectionStart, sectionEnd);

	const lines = section.split("\n");
	let toggled = false;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(/^(\s*-\s+\[)([ xX])(\]\s+)(.*?)(\r?)$/);
		if (!m) continue;
		const visibleText = m[4]!.trim();
		if (visibleText === text.trim()) {
			const nextState = m[2]!.toLowerCase() === "x" ? " " : "x";
			lines[i] = `${m[1]}${nextState}${m[3]}${m[4]}${m[5]}`;
			toggled = true;
			break;
		}
	}
	if (!toggled) return false;

	const newRaw = before + lines.join("\n") + after;
	return guardedModify(app, tfile, original, newRaw);
}

/**
 * Append a new `- [ ] text` line under the section `## <heading>`,
 * just before the next heading or end of file.
 */
export async function addTaskToSection(
	app: App,
	path: string,
	heading: string,
	text: string,
): Promise<boolean> {
	const trimmed = text.trim();
	if (!trimmed) return false;

	const file = app.vault.getAbstractFileByPath(path);
	if (!file || !("extension" in file)) return false;
	const tfile = file as TFile;
	const raw = await app.vault.read(tfile);
    const original = raw;

	const headingMarker = `## ${heading}`;
	const idx = raw.indexOf(headingMarker);
	if (idx < 0) return false;

	const afterHeading = idx + headingMarker.length;
	const nextSection = raw.indexOf("\n## ", afterHeading);
	const insertAt = nextSection < 0 ? raw.length : nextSection;

	// Walk back from insertAt to find the last non-blank line in this section.
	const sectionContent = raw.slice(afterHeading, insertAt);
	const trimmedSection = sectionContent.replace(/\s+$/, "");
	const newSection = `${trimmedSection}\n- [ ] ${trimmed}\n`;

	const newRaw = raw.slice(0, afterHeading) + newSection + raw.slice(insertAt);
	return guardedModify(app, tfile, original, newRaw);
}

/**
 * Set the text content of a Top 3 slot by index, preserving the checkbox state.
 * If the line for index doesn't exist yet, appends an unchecked entry with the
 * correct number prefix. Also updates frontmatter `top3` array.
 */
export async function setTop3TextByIndex(
	app: App,
	path: string,
	index: number,
	text: string,
): Promise<boolean> {
	if (index < 0 || index > 2) return false;
	const file = app.vault.getAbstractFileByPath(path);
	if (!file || !("extension" in file)) return false;
	const tfile = file as TFile;
	let raw = await app.vault.read(tfile);
    const original = raw;
	const trimmed = text.trim();

	// 1. Update the body's numbered list line.
	const headingMarker = "## Top 3 Priorities";
	const idx = raw.indexOf(headingMarker);
	if (idx < 0) return false;

	const afterHeading = idx + headingMarker.length;
	const nextSection = raw.indexOf("\n## ", afterHeading);
	const sectionEnd = nextSection < 0 ? raw.length : nextSection;
	const before = raw.slice(0, afterHeading);
	const after = raw.slice(sectionEnd);
	const section = raw.slice(afterHeading, sectionEnd);

	const lines = section.split("\n");
	let found = false;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(/^(\s*)(\d+)(\.\s+\[)([ xX])(\]\s+)(.*?)(\r?)$/);
		if (!m) continue;
		const lineIdx = parseInt(m[2]!, 10) - 1;
		if (lineIdx === index) {
			lines[i] = `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${trimmed}${m[7]}`;
			found = true;
			break;
		}
	}
	if (!found) {
		// Re-emit 3 lines from scratch if structure is degraded.
		// Conservative: just append at end of section.
		lines.push(`${index + 1}. [ ] ${trimmed}`);
	}

	raw = before + lines.join("\n") + after;

	// 2. Update frontmatter `top3` array if present.
	if (raw.startsWith("---")) {
		const fmEnd = raw.indexOf("\n---", 3);
		if (fmEnd > 0) {
			const fmBlock = raw.slice(3, fmEnd);
			const fmLines = fmBlock.split("\n");
			let inTop3 = false;
			let arrIdx = 0;
			for (let i = 0; i < fmLines.length; i++) {
				const line = fmLines[i]!;
				if (line.startsWith("top3:")) {
					inTop3 = true;
					arrIdx = 0;
					continue;
				}
				if (inTop3) {
					if (line.startsWith("  - ")) {
						if (arrIdx === index) {
							fmLines[i] = `  - ${JSON.stringify(trimmed)}`;
						}
						arrIdx++;
					} else if (line.length > 0 && !line.startsWith(" ")) {
						inTop3 = false;
					}
				}
			}
			raw = `---${fmLines.join("\n")}\n---` + raw.slice(fmEnd + 4);
		}
	}

	return guardedModify(app, tfile, original, raw);
}

/**
 * Toggle a numbered Top 3 item by position (0-2).
 * Format on disk: `1. [ ] text` / `1. [x] text`.
 */
export async function toggleTop3ByIndex(
	app: App,
	path: string,
	index: number,
): Promise<boolean> {
	if (index < 0 || index > 2) return false;
	const file = app.vault.getAbstractFileByPath(path);
	if (!file || !("extension" in file)) return false;
	const tfile = file as TFile;
	const raw = await app.vault.read(tfile);
    const original = raw;

	const headingMarker = "## Top 3 Priorities";
	const idx = raw.indexOf(headingMarker);
	if (idx < 0) return false;

	const afterHeading = idx + headingMarker.length;
	const nextSection = raw.indexOf("\n## ", afterHeading);
	const sectionEnd = nextSection < 0 ? raw.length : nextSection;

	const before = raw.slice(0, afterHeading);
	const after = raw.slice(sectionEnd);
	const section = raw.slice(afterHeading, sectionEnd);

	const lines = section.split("\n");
	let found = -1;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(/^(\s*)(\d+)(\.\s+\[)([ xX])(\]\s+)(.*?)(\r?)$/);
		if (!m) continue;
		const lineIdx = parseInt(m[2]!, 10) - 1;
		if (lineIdx === index) {
			const nextState = m[4]!.toLowerCase() === "x" ? " " : "x";
			lines[i] = `${m[1]}${m[2]}${m[3]}${nextState}${m[5]}${m[6]}${m[7]}`;
			found = i;
			break;
		}
	}
	if (found < 0) return false;

	const newRaw = before + lines.join("\n") + after;
	return guardedModify(app, tfile, original, newRaw);
}
