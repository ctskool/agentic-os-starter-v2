import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactOutcomeSpeech,pendingArtifactPresentation} from '../runner/artifact-speech.mjs';
const artifact={id:'file',mime:'image/png'};

for(const text of ["Here's the poster, now open in the dashboard.",'The graphic should be showing on your screen now.',"It's open in a new tab.",'The document is currently rendered inside another viewer.']){
 test(`viewer location claim is guarded with or without registered output: ${text}`,()=>{
  for(const artifacts of [[],[artifact]]){
   const turn={text,artifacts},spoken=artifactOutcomeSpeech({},turn);
   assert.match(spoken,/ready to view/);
   assert.doesNotMatch(spoken,/open in|showing on|rendered inside/);
   assert.equal(turn.text,text);
  }
 });
}

test('presentation failures, conditions and ordinary descriptions retain their meaning',()=>{
 for(const text of ["It isn't open in a new tab.",'The graphic is not showing on your screen.','If it is open in the dashboard, you can inspect it.','The chart shows how screen rendering works.'])assert.equal(pendingArtifactPresentation(text),text);
 assert.doesNotMatch(artifactOutcomeSpeech({}, {text:"I've created and displayed the explainer."}),/displayed/);
});

test('unrelated qualifications cannot authorize another clause claiming successful presentation',()=>{
 for(const conjunction of [', but',', and','; however,']){
  const text=`I have not verified the counts${conjunction} the image is now displayed in the dashboard.`;
  const spoken=artifactOutcomeSpeech({}, {text});
  assert.match(spoken,/not verified the counts/);assert.match(spoken,/ready to view/);assert.doesNotMatch(spoken,/displayed/);
 }
});

test('active presentation predicates cover tense and aspect without claiming a viewer location',()=>{
 for(const predicate of ['I am showing','We are displaying','I’m opening','We’ve shown','I have opened','I pulled up']){
  const spoken=artifactOutcomeSpeech({}, {text:`${predicate} the image in the dashboard now. The attribution remains uncertain.`});
  assert.match(spoken,/prepared the image/);assert.match(spoken,/attribution remains uncertain/);assert.doesNotMatch(spoken,/dashboard|showing|displaying|opening|shown|opened|pulled up/);
 }
});

test('active descriptions of findings retain their factual meaning',()=>{
 for(const text of ['We show a 12% reduction in processing time.','I am showing a 12% decline in the chart.','We have shown that the result is uncertain.']){
  assert.equal(pendingArtifactPresentation(text),text);assert.doesNotMatch(artifactOutcomeSpeech({}, {text}),/prepared/);
 }
});

test('artifact speech preserves the actual result and its verification caveat without claiming display',()=>{
 const text="I've created and displayed the explainer. It shows the decoding method and the failed replication. I haven't independently rerun the counts, so it presents those findings as reported.";
 const turn={text,artifacts:[artifact]},spoken=artifactOutcomeSpeech({},turn);
 assert.match(spoken,/created the explainer/);assert.match(spoken,/shows the decoding method/);assert.match(spoken,/haven't independently rerun the counts/);assert.doesNotMatch(spoken,/displayed/);assert.equal(turn.text,text);
});

test('presentation wording is normalized for different artifact kinds while descriptions and negation survive',()=>{
 for(const text of ['I opened the report.','We have displayed the diagram.','I’ve shown the preview.','I pulled up the document.'])assert.match(pendingArtifactPresentation(text),/prepared/);
 for(const text of ['The image is now displayed in Obsidian.','The report has been opened.','It is visible in the dashboard.'])assert.match(pendingArtifactPresentation(text),/ready to view/);
 for(const text of ["I couldn't open the report.",'The image is not displayed.','The chart shows the mechanism.','I have shown how the method works.'])assert.equal(pendingArtifactPresentation(text),text);
 assert.match(pendingArtifactPresentation('I saved the file and opened it.'),/saved the file and prepared it for viewing/);
});

test('partial import errors never claim that all outputs were lost',()=>{
 const spoken=artifactOutcomeSpeech({}, {text:'I created two comparison charts. The second uses unverified source data.',artifacts:[artifact],artifactErrors:['Second image unavailable']});
 assert.match(spoken,/created two comparison charts/);assert.match(spoken,/unverified source data/);assert.match(spoken,/Some files couldn't be made available here/);
 const failed=artifactOutcomeSpeech({}, {text:'I prepared the image.',artifactErrors:['No supported output']});assert.match(failed,/couldn't make the output available here/);assert.doesNotMatch(failed,/Your image is ready/);
});

test('a workflow save rejection stays authoritative even when an artifact is valid',()=>{
 const spoken=artifactOutcomeSpeech({workflowCompleted:true,workflowStatus:'error',error:'The destination changed, so the existing note was preserved.'},{text:'I created and displayed the finished report.',artifacts:[artifact]});
 assert.match(spoken,/workflow did not complete/);assert.match(spoken,/existing note was preserved/);assert.doesNotMatch(spoken,/finished report/);
});

test('long artifact results retain late limitations through the existing speech budget',()=>{
 const spoken=artifactOutcomeSpeech({}, {text:'I created and displayed the diagram.\n\n'+'Each label explains a stage of the method. '.repeat(30)+'\n\nHowever, the attribution remains uncertain.',artifacts:[artifact]});
 assert.match(spoken,/created the diagram/);assert.match(spoken,/attribution remains uncertain/);assert.doesNotMatch(spoken,/displayed/);assert.ok(spoken.length<=420);
});

test('ordinary nonartifact completion behavior is unchanged and structural output gets a factual pointer',()=>{
 assert.equal(artifactOutcomeSpeech({}, {text:'The task is blocked because access is unavailable.'}),'The task is blocked because access is unavailable.');
 assert.equal(artifactOutcomeSpeech({}, {text:'![Generated image](image.png)',artifacts:[artifact]}),'Your file is ready.');
});

test('retained drafts never inflate the number of final files announced',()=>{
 const draft={...artifact,isFinal:false,open:false},final={...artifact,isFinal:true,open:true};
 assert.equal(artifactOutcomeSpeech({}, {text:'![Final image](final.png)',artifacts:[final,draft,draft]}),'Your file is ready.');
 assert.equal(artifactOutcomeSpeech({}, {text:'![Final image](final.png)',artifacts:[artifact,draft]}),'Your file is ready.','legacy artifacts without final metadata remain available');
});

test('a missing final file cannot borrow success from a retained draft',()=>{
 const spoken=artifactOutcomeSpeech({}, {text:'The final image could not be saved.',artifacts:[{...artifact,isFinal:false,open:false}],artifactErrors:['The final file is missing.']});
 assert.match(spoken,/final image could not be saved/);assert.match(spoken,/couldn't make the output available here/);assert.doesNotMatch(spoken,/Some files|ready/);
});
