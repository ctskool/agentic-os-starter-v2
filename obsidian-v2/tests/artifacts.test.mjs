import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {registerArtifact,readArtifact,captureTurnArtifacts,linkedArtifacts,MAX_ARTIFACT_BYTES} from '../runner/artifacts.mjs';
import {captureTranscriptArtifacts} from '../runner/artifact-transcript.mjs';
import {TerminalManager} from '../runner/terminals.mjs';
import {selectedTaskContext} from '../runner/voice-task-context.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=','base64');
const session='01a09b1a-fb81-7433-a9d7-d8333de6cbe0',turn='01a0a104-68da-7581-bb27-86145756885f';
function fixture(t){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'aos-artifacts-')),root=path.join(base,'vault'),codexHome=path.join(base,'codex');fs.mkdirSync(root);fs.mkdirSync(codexHome);
 const result={base,root,codexHome,taskId:crypto.randomUUID()};
 t.after(()=>{result.manager?.close();fs.rmSync(base,{recursive:true,force:true});});
 return result;
}
function write(file,bytes=png){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;}

test('registered files retain immutable copies and duplicate completion references have stable IDs',t=>{
 const f=fixture(t),source=write(path.join(f.root,'outputs','graphic.png'));
 const meta={taskId:f.taskId,turnId:turn,path:source,label:'Cipher explainer',open:true};
 const first=registerArtifact(f.root,meta),again=registerArtifact(f.root,meta);
 assert.equal(first.id,again.id);assert.equal(first.mime,'image/png');assert.equal(first.open,true);
 assert.ok(first.path.startsWith('system/v2/artifacts/files/'));
 const reopened=registerArtifact(f.root,{...meta,turnId:'reopened'});
 assert.notEqual(reopened.id,first.id);assert.equal(reopened.path,first.path);
 assert.equal(fs.readdirSync(path.join(f.root,'system','v2','artifacts','files')).length,1,'A later open keeps one immutable content file');
 fs.writeFileSync(source,Buffer.concat([png,Buffer.from('later version')]));
 const saved=readArtifact(f.root,first.id);assert.deepEqual(fs.readFileSync(saved.absolutePath),png);
 assert.equal(saved.artifact.label,'Cipher explainer');
 const next=registerArtifact(f.root,{...meta,turnId:'next'});assert.notEqual(next.id,first.id);assert.notEqual(next.path,first.path);
 assert.equal(fs.readdirSync(path.join(f.root,'system','v2','artifacts','files')).length,2);
 assert.deepEqual(readArtifact(f.root,reopened.id).bytes,png,'Earlier references retain their exact bytes after source edits');
 fs.writeFileSync(saved.absolutePath,'tampered');assert.throws(()=>readArtifact(f.root,first.id));
});

test('artifact registry rejects arbitrary external files, hidden config, traversal, remote URLs and mismatched files',t=>{
 const f=fixture(t),outside=write(path.join(f.base,'outside.png'));
 const register=source=>registerArtifact(f.root,{taskId:f.taskId,turnId:turn,sessionId:session,path:source},{codexHome:f.codexHome});
 for(const source of [outside,'../outside.png','%2e%2e/outside.png','https://example.com/image.png','data:image/png;base64,abc','file:///tmp/image.png'])assert.throws(()=>register(source));
 write(path.join(f.root,'.obsidian','private.md'),'secret');assert.throws(()=>register('.obsidian/private.md'),/Private/);
 write(path.join(f.root,'bad.png'),'not an image');assert.throws(()=>register('bad.png'),/contents/);
 write(path.join(f.root,'run.html'),'<script>bad()</script>');assert.throws(()=>register('run.html'),/type/);
 write(path.join(f.root,'image.svg'),'<svg/>');assert.throws(()=>register('image.svg'),/type/);
 const huge=path.join(f.root,'huge.png');const fd=fs.openSync(huge,'w');fs.ftruncateSync(fd,MAX_ARTIFACT_BYTES+1);fs.closeSync(fd);assert.throws(()=>register('huge.png'),/large/);
 assert.throws(()=>readArtifact(f.root,'../private'));assert.throws(()=>register('missing.png'));
});

test('symlink and directory-junction outputs cannot escape the vault or generated session folder',t=>{
 const f=fixture(t),outside=path.join(f.base,'outside');write(path.join(outside,'image.png'));
 const linked=path.join(f.root,'linked');fs.symlinkSync(outside,linked,'junction');
 assert.throws(()=>registerArtifact(f.root,{taskId:f.taskId,turnId:turn,path:path.join(linked,'image.png')}),/Linked/);
 const generated=path.join(f.codexHome,'generated_images');fs.mkdirSync(generated);fs.symlinkSync(outside,path.join(generated,session),'junction');
 assert.throws(()=>registerArtifact(f.root,{taskId:f.taskId,turnId:turn,sessionId:session,path:path.join(generated,session,'image.png')},{codexHome:f.codexHome}),/Linked/);
});

test('exact Codex session can import a generated PNG without permitting a different session',t=>{
 const f=fixture(t),source=write(path.join(f.codexHome,'generated_images',session,'exec-image.png'));
 const artifact=registerArtifact(f.root,{taskId:f.taskId,turnId:turn,sessionId:session,path:source,open:true},{codexHome:f.codexHome});
 assert.deepEqual(fs.readFileSync(readArtifact(f.root,artifact.id).absolutePath),png);assert.deepEqual(fs.readFileSync(source),png);
 assert.throws(()=>registerArtifact(f.root,{taskId:f.taskId,turnId:turn,sessionId:crypto.randomUUID(),path:source},{codexHome:f.codexHome}));
});

test('actual imagegen-shaped Codex completion captures a file even with no final link and ignores prior turns',t=>{
 const f=fixture(t),source=write(path.join(f.codexHome,'generated_images',session,'exec-current.png')),older=write(path.join(f.codexHome,'generated_images',session,'exec-old.png'));
 const transcript=path.join(f.codexHome,'sessions','2026','09','13',`rollout-2026-09-13T09-10-32-${session}.jsonl`);
 const output=file=>({timestamp:'2026-09-14T17:45:18.534Z',type:'response_item',payload:{type:'custom_tool_call_output',output:JSON.stringify([{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')},{type:'input_text',text:`Generated images are saved to ${path.dirname(file)} as ${file} by default.\nThe generated image is already displayed to the user.`}])}});
 write(transcript,[{type:'turn_context',payload:{turn_id:'old'}},output(older),{type:'event_msg',payload:{type:'task_started',turn_id:turn}},output(source),{type:'event_msg',payload:{type:'task_complete',turn_id:turn}}].map(JSON.stringify).join('\n'));
 const candidates=captureTranscriptArtifacts({provider:'codex',sessionId:session,turnId:turn,text:'I created and displayed the explainer.',ts:Date.parse('2026-09-14T17:45:26Z')},{codexHome:f.codexHome});
 assert.equal(candidates.length,1);assert.equal(candidates[0].path,source);assert.equal(candidates[0].open,true);
 const result=captureTurnArtifacts(f.root,{id:f.taskId,sessionId:session},{turnId:turn,text:'I created and displayed the explainer.',artifactCandidates:candidates},{codexHome:f.codexHome});
 assert.equal(result.artifacts.length,1);assert.deepEqual(result.errors,[]);
 assert.deepEqual(captureTranscriptArtifacts({provider:'codex',sessionId:session,turnId:'unknown'},{codexHome:f.codexHome}),[]);
});

test('Claude tool output capture is bounded to its matching session and last user turn',t=>{
 const f=fixture(t),projects=path.join(f.base,'claude-projects'),file=path.join(projects,'project',`${session}.jsonl`),image=write(path.join(f.root,'outputs','claude.png'));
 const row=(type,content,sessionId=session)=>({sessionId,type,message:{content}});
 write(file,[row('user','Old request'),row('user',[{type:'tool_result',content:'![old](outputs/old.png)'}]),row('assistant','Old answer'),row('user','Create the image'),row('user',[{type:'tool_result',content:`![Image](<${image}>)`}]),row('assistant',[{type:'text',text:'Created.'}])].map(JSON.stringify).join('\n'));
 const candidates=captureTranscriptArtifacts({provider:'claude',sessionId:session,turnId:turn,transcriptPath:file,text:'Created.'},{claudeProjects:projects});
 assert.deepEqual(candidates,[{path:image,label:'Image',open:true}]);
 assert.deepEqual(captureTranscriptArtifacts({provider:'claude',sessionId:session,transcriptPath:file,text:'Wrong completion'},{claudeProjects:projects}),[]);
 assert.deepEqual(captureTranscriptArtifacts({provider:'claude',sessionId:crypto.randomUUID(),transcriptPath:file,text:'Created.'},{claudeProjects:projects}),[]);
});

for(const provider of ['codex','claude'])test(`${provider} explicit helper attaches to the exact request; invalid output does not swallow completion`,t=>{
 const f=fixture(t),processes=[];
 const manager=f.manager=new TerminalManager(f.root,{directory:path.join(f.base,'tasks'),spawn(command,args,options){const proc={pid:10,env:options.env,onData(){},onExit(){},write(){},kill(){},resize(){}};processes.push(proc);return proc;}});
 const record=manager.start({selection:{provider,model:provider==='codex'?'gpt-6-astra':'sonnet'},prompt:'Create and show a file'});
 const file=write(path.join(f.root,'outputs','answer.md'),'# Result\nA useful document.');
 const helper=fileURLToPath(new URL('../runner/artifact-result.mjs',import.meta.url));
 const result=spawnSync(process.execPath,[helper,file,'--open','--label','Answer'],{env:processes[0].env,cwd:f.root,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
 manager.collect(record.id);manager.accept(record.id,{type:provider==='codex'?'complete':'Stop',sessionId:session,turnId:turn,text:'Created.'});
 assert.equal(record.turns.length,1);assert.equal(record.turns[0].artifacts[0].open,true);assert.equal(record.turns[0].artifacts[0].turnId,turn);
 const context=selectedTaskContext(record);assert.equal(context.artifacts[0].path,record.turns[0].artifacts[0].path);
 manager.accept(record.id,{type:'complete',sessionId:session,turnId:turn,text:'Duplicate'});assert.equal(record.turns.length,1);
 const oldKey=record.artifactRequestKey;manager.send(record.id,'New request');
 manager.accept(record.id,{type:'artifact',taskId:record.id,requestKey:oldKey,path:file,open:true,ts:Date.now()});assert.equal(record.pendingArtifacts.length,0);
 manager.accept(record.id,{type:'complete',sessionId:session,turnId:'second',text:'Saved file.',artifactCandidates:[{path:'missing.png',open:true}]});
 assert.equal(record.state,'ready');assert.equal(record.turns.at(-1).text,'Saved file.');assert.ok(record.turns.at(-1).artifactErrors.length);assert.equal(record.turns.at(-1).artifacts,undefined);
});

test('Markdown links register actual local destinations and do not convert prose or URLs into files',()=>{
 assert.deepEqual(linkedArtifacts('Saved to imaginary.png. [Web](https://example.com/a.png) ![Preview](<outputs/my image.png>) [Document](notes/report.md)'),[{path:'outputs/my image.png',label:'Preview',open:true},{path:'notes/report.md',label:'Document',open:false}]);
});

test('helper paths preserve literal percent signs and never select a decoded neighboring file',t=>{
 const f=fixture(t),literalPercent=write(path.join(f.root,'outputs','growth-50%.png'));
 const literalEscape=write(path.join(f.root,'outputs','growth-%20.png'),Buffer.concat([png,Buffer.from('literal')]));
 write(path.join(f.root,'outputs','growth- .png'),Buffer.concat([png,Buffer.from('decoded')]));
 const register=source=>registerArtifact(f.root,{taskId:f.taskId,turnId:turn,path:source});
 assert.deepEqual(readArtifact(f.root,register(literalPercent).id).bytes,png);
 assert.deepEqual(readArtifact(f.root,register(literalEscape).id).bytes,fs.readFileSync(literalEscape));
 assert.throws(()=>register('outputs/missing%20graphic.png'));
});

test('Markdown encoded spaces use a verified decoded fallback while existing literal filenames win',t=>{
 const f=fixture(t),spaced=write(path.join(f.root,'outputs','my graphic.png'));
 const literal=write(path.join(f.root,'outputs','literal%20name.png'),Buffer.concat([png,Buffer.from('literal')]));
 write(path.join(f.root,'outputs','literal name.png'),Buffer.concat([png,Buffer.from('decoded')]));
 const percent=write(path.join(f.root,'outputs','growth-50%.png'),Buffer.concat([png,Buffer.from('percent')]));
 const result=captureTurnArtifacts(f.root,{id:f.taskId},{turnId:turn,text:'![Spaced](outputs/my%20graphic.png) ![Literal](outputs/literal%20name.png) ![Percent](outputs/growth-50%.png)'});
 assert.deepEqual(result.errors,[]);assert.equal(result.artifacts.length,3);
 assert.deepEqual(readArtifact(f.root,result.artifacts[0].id).bytes,fs.readFileSync(spaced));
 assert.deepEqual(readArtifact(f.root,result.artifacts[1].id).bytes,fs.readFileSync(literal));
 assert.deepEqual(readArtifact(f.root,result.artifacts[2].id).bytes,fs.readFileSync(percent));
 const invalid=captureTurnArtifacts(f.root,{id:f.taskId},{turnId:'unsafe',text:'![Escape](%2e%2e/outside.png)'});
 assert.equal(invalid.artifacts.length,0);assert.equal(invalid.errors.length,1);
});
