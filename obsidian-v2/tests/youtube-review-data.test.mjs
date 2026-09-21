import test from 'node:test';
import assert from 'node:assert/strict';
import {collectYouTubeReview} from '../runner/youtube-review-data.mjs';

const env={YOUTUBE_API_KEY:'test-secret-that-must-never-be-returned',YOUTUBE_CHANNEL_ID:'UC'+'a'.repeat(22)},now=new Date('2026-09-15T17:00:00Z');
const id=index=>'v'+String(index).padStart(10,'0');
const video=(index,publishedAt='2026-09-14T12:00:00Z',duration='PT10M',statistics={viewCount:'100',likeCount:'10',commentCount:'2'})=>({id:id(index),snippet:{channelId:env.YOUTUBE_CHANNEL_ID,title:`Video ${index}`,publishedAt},contentDetails:{duration},statistics});
const entry=item=>({contentDetails:{videoId:item.id,videoPublishedAt:item.snippet.publishedAt}});
const json=body=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
function fixture({videos=[],pages,hiddenSubscribers=false,missingIds=[],channelItems}={}){
 const calls=[],byId=new Map(videos.map(item=>[item.id,item]));
 const channel={id:env.YOUTUBE_CHANNEL_ID,snippet:{title:'My channel'},statistics:{subscriberCount:'123000',hiddenSubscriberCount:hiddenSubscribers,viewCount:'9876543',videoCount:'500'},contentDetails:{relatedPlaylists:{uploads:'UU'+env.YOUTUBE_CHANNEL_ID.slice(2)}}};
 const playlistPages=pages||[{items:videos.map(entry)}];
 const fetchImpl=async(url,options)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://www.googleapis.com');assert.equal(parsed.searchParams.get('key'),env.YOUTUBE_API_KEY);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  calls.push({endpoint:parsed.pathname.split('/').at(-1),params:parsed.searchParams,options});
  if(parsed.pathname.endsWith('/channels')){assert.equal(parsed.searchParams.get('id'),env.YOUTUBE_CHANNEL_ID);return json({items:channelItems||[channel]})}
  if(parsed.pathname.endsWith('/playlistItems')){assert.equal(parsed.searchParams.get('playlistId'),'UU'+env.YOUTUBE_CHANNEL_ID.slice(2));assert.equal(parsed.searchParams.get('maxResults'),'50');return json(playlistPages[Number(parsed.searchParams.get('pageToken')||'0')])}
  if(parsed.pathname.endsWith('/videos')){const ids=parsed.searchParams.get('id').split(',');assert.ok(ids.length<=50);return json({items:ids.filter(key=>!missingIds.includes(key)).map(key=>byId.get(key)).filter(Boolean)})}
  assert.fail('Unexpected API endpoint');
 };
 return {fetchImpl,calls,channel};
}
test('pages past shorts to collect ten long-form baseline videos and stop after covering the full week',async()=>{
 const start=Date.parse('2026-09-14T18:00:00Z'),videos=[];
 for(let n=1;n<=65;n++)videos.push(video(n,new Date(start-(n-1)*2*3600000).toISOString(),n<=50?'PT1M':'PT10M',{viewCount:String(1000+n),likeCount:String(n),commentCount:'5'}));
 // Extend long-form history beyond the weekly start, preserving newest-first order.
 for(let n=50;n<65;n++)videos[n].snippet.publishedAt=new Date(Date.parse('2026-09-10T14:00:00Z')-(n-50)*12*3600000).toISOString();
 const f=fixture({videos,pages:[{items:videos.slice(0,50).map(entry),nextPageToken:'1'},{items:videos.slice(50).map(entry),nextPageToken:'2'}]});
 const result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});
 assert.equal(result.coverage.pages,2);assert.equal(result.coverage.windowComplete,true);assert.equal(result.coverage.baselineComplete,true);assert.equal(result.coverage.playlistExhausted,false);
 assert.equal(result.baseline.sampleSize,10);assert.equal(result.baseline.medianViews,1055.5);assert.deepEqual(result.baseline.videos.map(item=>item.id),videos.slice(50,60).map(item=>item.id));
 assert.equal(result.weekly.shortForm.length,50);assert.ok(result.weekly.longForm.length>0);assert.equal(f.calls.length,5);assert.ok(f.calls.filter(call=>call.endpoint==='videos').every(call=>call.params.get('id').split(',').length<=50));
 assert.equal(JSON.stringify(result).includes(env.YOUTUBE_API_KEY),false);
});
test('weekly membership uses completed Chicago dates, excluding today and the prior boundary',async()=>{
 const videos=[video(1,'2026-09-15T05:00:00Z'),video(2,'2026-09-15T04:59:59Z'),video(3,'2026-09-08T05:00:00Z'),video(4,'2026-09-08T04:59:59Z')];
 const f=fixture({videos}),result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});
 assert.equal(result.window.startDate,'2026-09-08');assert.equal(result.window.endDate,'2026-09-14');assert.equal(result.window.startInclusive,'2026-09-08T05:00:00.000Z');assert.equal(result.window.endExclusive,'2026-09-15T05:00:00.000Z');
 assert.deepEqual(result.weekly.longForm.map(item=>item.id),[id(2),id(3)]);assert.equal(result.baseline.videos[0].id,id(1));assert.match(result.baseline.definition,/today/);
});
for(const [at,start,end,hours] of [['2026-03-09T17:00:00Z','2026-03-02T06:00:00.000Z','2026-03-09T05:00:00.000Z',167],['2026-11-02T18:00:00Z','2026-10-26T05:00:00.000Z','2026-11-02T06:00:00.000Z',169]])test(`Chicago ${hours}-hour DST review window has seven local dates`,async()=>{
 const f=fixture(),result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now:new Date(at)});
 assert.equal(result.window.startInclusive,start);assert.equal(result.window.endExclusive,end);assert.equal((Date.parse(end)-Date.parse(start))/3600000,hours);
});
test('180-second shorts are separated and missing counts/durations stay unavailable',async()=>{
 const videos=[video(1,'2026-09-14T12:00:00Z','PT3M'),video(2,'2026-09-13T12:00:00Z','PT3M1S',{viewCount:'0',likeCount:'0',commentCount:'0'}),video(3,'2026-09-12T12:00:00Z','PT20M',{}),video(4,'2026-09-11T12:00:00Z','nonsense'),video(5,'2026-09-10T12:00:00Z','PT0S')];
 const f=fixture({videos,hiddenSubscribers:true}),result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});
 assert.equal(result.weekly.shortForm.length,1);assert.equal(result.weekly.longForm.length,2);assert.equal(result.weekly.unclassified.length,2);assert.equal(result.baseline.sampleSize,2);assert.equal(result.baseline.medianViews,0);assert.equal(result.baseline.medianEngagement,null);
 assert.deepEqual(result.baseline.metricSampleSizes,{views:1,likes:1,engagement:0});assert.equal(result.weekly.longForm[1].views,null);assert.equal(result.weekly.longForm[1].likes,null);assert.equal(result.weekly.longForm[1].comments,null);assert.equal(result.weekly.longForm[1].verdict,'Unavailable');
 assert.equal(result.channel.snapshot.subscribers,null);assert.equal(result.channel.snapshot.lifetimeViews,9876543);assert.match(result.channel.snapshot.note,/not seven-day or 28-day/);assert.ok(result.coverage.warnings.some(message=>message.includes('durations')));
});
test('private/deleted uploads are omitted with explicit incomplete data coverage',async()=>{
 const videos=[video(1),video(2,'2026-09-13T12:00:00Z')],f=fixture({videos,missingIds:[id(2)]});
 const result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});assert.equal(result.weekly.longForm.length,1);assert.equal(result.coverage.unavailableVideos,1);assert.equal(result.coverage.windowComplete,false);assert.equal(result.coverage.paginationCoveredWindow,true);assert.match(result.coverage.warnings.join(' '),/not treated as zero/);
});
test('empty uploads are an observed empty window, not an inaccessible channel',async()=>{
 const f=fixture(),result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});assert.deepEqual(result.weekly,{longForm:[],shortForm:[],unclassified:[]});assert.equal(result.coverage.windowComplete,true);assert.equal(result.baseline.sampleSize,0);assert.equal(result.baseline.medianViews,null);assert.equal(f.calls.length,2);
 const missing=fixture({channelItems:[]});await assert.rejects(collectYouTubeReview({env,fetchImpl:missing.fetchImpl,now}),/channel was not found/);assert.equal(missing.calls.length,1);
});
test('duplicate entries never duplicate statistics or bias the baseline',async()=>{
 const videos=[video(1),video(2,'2026-09-13T12:00:00Z')],f=fixture({videos,pages:[{items:[entry(videos[0]),entry(videos[0])],nextPageToken:'1'},{items:videos.map(entry)}]});
 const result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});assert.equal(result.weekly.longForm.length,2);assert.equal(result.baseline.sampleSize,2);assert.deepEqual(f.calls.filter(call=>call.endpoint==='videos').map(call=>call.params.get('id')),[id(1),id(2)]);
 assert.equal(result.coverage.warnings.some(message=>message.includes('not returned in publication order')),false);
});
test('out-of-order uploads prevent early stopping even after an old upload and ten long-form candidates',async()=>{
 const videos=Array.from({length:12},(_,n)=>video(n+1,new Date(Date.parse('2026-09-14T12:00Z')-n*24*3600000).toISOString()));
 const reordered=[...videos.slice(0,10),videos[11],videos[10]],f=fixture({videos,pages:[{items:reordered.map(entry),nextPageToken:'1'},{items:[]}]});
 const result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});assert.equal(result.coverage.pages,2);assert.equal(result.coverage.playlistExhausted,true);assert.match(result.coverage.warnings.join(' '),/not returned in publication order/);
});
test('collection stops at ten pages and reports incomplete coverage instead of inventing a baseline',async()=>{
 const videos=Array.from({length:500},(_,n)=>video(n+1,new Date(Date.parse('2026-09-14T12:00Z')-n*60000).toISOString(),'PT45S'));
 const pages=Array.from({length:10},(_,page)=>({items:videos.slice(page*50,(page+1)*50).map(entry),nextPageToken:String(page+1)})),f=fixture({videos,pages});
 const result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});assert.equal(result.coverage.pages,10);assert.equal(result.coverage.playlistEntriesSeen,500);assert.equal(result.coverage.windowComplete,false);assert.equal(result.baseline.sampleSize,0);assert.match(result.coverage.warnings.join(' '),/500-upload collection limit/);assert.equal(f.calls.length,21);
});
test('HTTP errors, network messages and malformed responses never reveal the API key or response body',async()=>{
 for(const fetchImpl of [async()=>new Response('SECRET BODY '+env.YOUTUBE_API_KEY,{status:403}),async()=>{throw new Error('network error '+env.YOUTUBE_API_KEY)},async()=>new Response('not json '+env.YOUTUBE_API_KEY,{status:200}),async()=>json({items:'invalid'})]){
  await assert.rejects(collectYouTubeReview({env,fetchImpl,now}),error=>{assert.equal(error.message.includes(env.YOUTUBE_API_KEY),false);assert.equal(error.message.includes('SECRET BODY'),false);assert.match(error.message,/YouTube/);return true});
 }
});
test('credentials, channel validation and already-cancelled requests fail before any network request',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;assert.fail('Must not fetch')};
 for(const configured of [{},{YOUTUBE_API_KEY:env.YOUTUBE_API_KEY},{...env,YOUTUBE_CHANNEL_ID:'https://evil.example/channel'}])await assert.rejects(collectYouTubeReview({env:configured,fetchImpl,now}),/configured|required/);
 await assert.rejects(collectYouTubeReview({env,fetchImpl,now,signal:AbortSignal.abort()}),/cancelled/);assert.equal(calls,0);
});
test('cancellation interrupts an in-flight read even if an injected fetch never settles',async()=>{
 const controller=new AbortController();let received;
 const result=collectYouTubeReview({env,now,signal:controller.signal,fetchImpl:async(_url,options)=>{received=options.signal;return new Promise(()=>{})}});
 controller.abort();await assert.rejects(result,/cancelled/);assert.equal(received.aborted,true);
});
test('each Data API request has a ten-second deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const result=collectYouTubeReview({env,now,fetchImpl:async()=>new Promise(()=>{})});t.mock.timers.tick(10000);await assert.rejects(result,/request timed out/);
});
test('multiple individually timely API calls cannot exceed the sixty-second overall budget',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const videos=Array.from({length:10},(_,n)=>video(n+1,new Date(Date.parse('2026-09-14T12:00Z')-n*60000).toISOString(),'PT45S'));
 const f=fixture({videos,pages:videos.map((item,n)=>({items:[entry(item)],nextPageToken:String(n+1)}))});
 const fetchImpl=(url,options)=>new Promise(resolve=>setTimeout(()=>resolve(f.fetchImpl(url,options)),9000));
 const completed=collectYouTubeReview({env,now,fetchImpl}).then(()=>null,error=>error);
 for(let n=0;n<7;n++){t.mock.timers.tick(9000);await new Promise(setImmediate)}
 const error=await completed;assert.match(error.message,/60-second limit/);assert.ok(f.calls.length<=7);
});
test('returned channel and video text cannot echo a configured credential',async()=>{
 const v=video(1);v.snippet.title='An echoed value '+env.YOUTUBE_API_KEY;const f=fixture({videos:[v]});f.channel.snippet.title=env.YOUTUBE_API_KEY;
 const result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});assert.equal(JSON.stringify(result).includes(env.YOUTUBE_API_KEY),false);assert.equal(result.channel.title,'[redacted]');assert.match(result.weekly.longForm[0].title,/redacted/);
});
test('malformed pagination or a video outside the channel fails closed',async()=>{
 const v=video(1),f=fixture({videos:[v],pages:[{items:[entry(v)],nextPageToken:'1'},{items:[],nextPageToken:'1'}]});
 await assert.rejects(collectYouTubeReview({env,fetchImpl:f.fetchImpl,now}),/pagination/);
 v.snippet.channelId='UC'+'b'.repeat(22);const wrong=fixture({videos:[v]});await assert.rejects(collectYouTubeReview({env,fetchImpl:wrong.fetchImpl,now}),/did not match/);
});
test('invalid publication dates cannot masquerade as old uploads or complete coverage',async()=>{
 const v=video(1,'2026-02-31T12:00:00Z'),f=fixture({videos:[v]}),result=await collectYouTubeReview({env,fetchImpl:f.fetchImpl,now});
 assert.equal(result.coverage.windowComplete,false);assert.equal(result.baseline.sampleSize,0);assert.match(result.coverage.warnings.join(' '),/publication dates/);
});
