// Lightweight instructions shared by worker launch and synchronous prompt hooks.
// Keep this module free of speech formatters and model/runtime dependencies.
export const ARTIFACT_HANDOFF_INSTRUCTIONS = 'Result handoff: After creating a local image, PDF, Markdown document, or text file, register only the final intended output with the dashboard helper. When the user asks to open, show, display, or pull up a result, use the helper with --open; this applies to previous results too. Reuse the known file for follow-ups instead of recreating it. Use the concrete command supplied for this request; worker tools may not inherit terminal environment variables. Omit --open when merely saving a nonvisual result. Register the final original output of image tools even when that tool says the image was already displayed: the terminal tool rendering is separate from the user dashboard. Do not claim that a file is opened or displayed; the dashboard confirms presentation separately. Report the created result naturally and include a real local file link in written details when the requested output format permits. This helper is for result presentation, not another model call or speech rewrite. HTML, SVG and other web files cannot be displayed in Obsidian or on the dashboard: a visual result must be a PNG, JPEG, WebP, GIF or PDF file, and a written result a Markdown or text file.';
export function artifactHandoffInstructions({node,helper,events,taskId,requestKey,provider,platform=process.platform}={}){
 if(!node||!helper||!events||!/^[a-f0-9-]{36}$/.test(taskId||'')||!/^[a-f0-9-]{36}$/.test(requestKey||''))return ARTIFACT_HANDOFF_INSTRUCTIONS;
 // Claude's Windows Bash tool uses Git Bash; Codex uses PowerShell.
 const powershell=platform==='win32'&&provider!=='claude';
 const quote=value=>powershell?`'${String(value).replaceAll("'","''")}'`:`'${String(value).replaceAll("'",`'"'"'`)}'`;
 // Git Bash needs a slash-separated executable path. The remaining arguments
 // are literal Windows paths consumed by Node, so preserve them verbatim.
 const executable=platform==='win32'&&!powershell?String(node).replaceAll('\\','/'):node;
 const args=[executable,helper,'<actual local file>','--outbox',events,'--task',taskId,'--request',requestKey,'--open','--label','<short title>'];
 return `${ARTIFACT_HANDOFF_INSTRUCTIONS}\nCurrent request handoff command (${powershell?'PowerShell':'Bash'}):\n${powershell?'& ':''}${args.map(quote).join(' ')}\nReplace only the file and title placeholders. Keep this request identity unchanged; do not reuse an earlier request command.`;
}
