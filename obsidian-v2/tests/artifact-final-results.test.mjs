import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {captureTurnArtifacts,registerArtifact,promiseOpen} from '../runner/artifacts.mjs';
import {ArtifactHandoff} from '../runner/artifact-handoff.mjs';
import {selectedTaskContext} from '../runner/voice-task-context.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV1kAAAAASUVORK5CYII=','base64');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-final-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const record={id:crypto.randomUUID(),turns:[]};
 const write=(name,content=Buffer.concat([png,Buffer.from(name)]))=>{fs.writeFileSync(path.join(root,name),content);return {path:name,open:true}};
 const capture=(text,discovered=[],helpers=[])=>captureTurnArtifacts(root,record,{turnId:'turn',text,artifactCandidates:discovered},{candidates:helpers});
 return {root,record,write,capture};
}
test('three generated revisions produce one final presentation even when every revision requested open',t=>{
 const f=fixture(t),versions=['draft.png','revised.png','final.png'].map(name=>f.write(name));
 const result=f.capture('[View the graphic](final.png)',versions,versions);
 assert.deepEqual(result.errors,[]);assert.equal(result.artifacts.length,3);
 const final=result.artifacts.filter(item=>item.open);assert.equal(final.length,1);assert.equal(final[0].label,'View the graphic');assert.equal(final[0].isFinal,true);
 assert.equal(result.artifacts.filter(item=>item.isFinal===false).length,2);
 f.record.turns=[{id:'turn',artifacts:result.artifacts}];assert.deepEqual(selectedTaskContext(f.record).artifacts.map(item=>item.id),[final[0].id]);
 const queue=new ArtifactHandoff();queue.bind(f.record.id,{client:'native'});assert.equal(queue.publish(f.record,f.record.turns[0]),1);
 assert.equal(queue.claim('native').artifact.id,final[0].id);assert.equal(queue.claim('native'),null);
});
test('no final link falls back to the last generated image, never every intermediate',t=>{
 const f=fixture(t),versions=['first.png','second.png','third.png'].map(name=>f.write(name));
 const result=f.capture('Created the visual.',versions);
 assert.equal(result.artifacts.filter(item=>item.open).length,1);assert.equal(result.artifacts.find(item=>item.open).label,'third.png');
});
test('distinct final outputs remain separate; repeated aliases of the same bytes open once',t=>{
 const f=fixture(t);f.write('a.png');f.write('b.png');f.write('copy.png',fs.readFileSync(path.join(f.root,'a.png')));
 const result=f.capture('![A](a.png) [Download A](copy.png) ![B](b.png)',[{path:'a.png',open:true}],[{path:'copy.png',open:true}]);
 assert.equal(result.artifacts.length,2);assert.equal(result.artifacts.filter(item=>item.open).length,2);
});
test('JPEG suffix aliases share a single content identity in the registry and delivery queue',t=>{
 const f=fixture(t),jpg=Buffer.from([255,216,255,224,1,2,3]);f.write('one.jpg',jpg);f.write('alias.jpeg',jpg);
 const result=f.capture('[One](one.jpg) [Same image](alias.jpeg)');assert.equal(result.artifacts.length,1);
 const first=registerArtifact(f.root,{taskId:f.record.id,turnId:'turn',path:'one.jpg',open:true}),alias=registerArtifact(f.root,{taskId:f.record.id,turnId:'turn',path:'alias.jpeg',open:true});
 const queue=new ArtifactHandoff();queue.bind(f.record.id,{client:'native'});assert.equal(queue.publish(f.record,{id:'turn',artifacts:[first,alias]}),1);
 assert.equal(queue.publish(f.record,{id:'turn',artifacts:[alias]}),0);
});
test('missing final output or latest discovered image never substitutes an older draft',t=>{
 const f=fixture(t),draft=f.write('draft.png');
 for(const result of [f.capture('[Final](missing.png)',[draft]),f.capture('Ready.',[draft,{path:'missing.png',open:true}])]){
  assert.equal(result.artifacts.filter(item=>item.open).length,0);assert.ok(result.errors.length);
 }
});
test('without final links, latest explicit helper selects a document and does not auto-open earlier images',t=>{
 const f=fixture(t),draft=f.write('draft.png'),doc=f.write('result.md',Buffer.from('# Final document'));
 const result=f.capture('The document is ready.',[draft],[draft,doc]);
 assert.equal(result.artifacts.filter(item=>item.open).length,1);assert.equal(result.artifacts.find(item=>item.open).mime,'text/markdown');
});
test('a final saved document is kept for follow-ups without opening an unrelated image',t=>{
 const f=fixture(t),draft=f.write('draft.png');f.write('result.md',Buffer.from('# Final document'));
 const result=f.capture('[Report](result.md)',[draft]);assert.equal(result.artifacts.filter(item=>item.open).length,0);
 assert.deepEqual(result.artifacts.filter(item=>item.isFinal).map(item=>item.mime),['text/markdown']);
});
test('a promised open promotes exactly one final output and leaves an already-open set alone',t=>{
 const f=fixture(t),draft=f.write('draft.png');f.write('result.md',Buffer.from('# Final document'));
 const result=f.capture('[Report](result.md)',[draft]);assert.equal(result.artifacts.filter(item=>item.open).length,0);
 const promoted=promiseOpen(result.artifacts);
 assert.equal(promoted.filter(item=>item.open).length,1);assert.equal(promoted.find(item=>item.open).mime,'text/markdown');assert.equal(promoted.find(item=>item.open).isFinal,true);
 assert.equal(result.artifacts.filter(item=>item.open).length,0);
 const already=f.capture('[View the graphic](final.png)',[f.write('final.png')]);
 assert.equal(promiseOpen(already.artifacts),already.artifacts);
 assert.deepEqual(promiseOpen([]),[]);
});
test('a promised open never promotes a draft after a failed final export, and the promise is kept',t=>{
 const f=fixture(t),draft=f.write('draft.png');
 const result=f.capture('[Final](missing.png)',[draft]);
 assert.equal(result.artifacts.filter(item=>item.open).length,0);assert.ok(result.errors.length);
 assert.equal(promiseOpen(result.artifacts),result.artifacts);
});
