import test from 'node:test';
import assert from 'node:assert/strict';
import {collectYouTubeResearch} from '../runner/youtube-research-data.mjs';

const env={YOUTUBE_API_KEY:'research-fixture-secret-do-not-return'},now=new Date('2026-09-15T17:00:00Z');
const channelId='UC'+'a'.repeat(22),otherChannel='UC'+'b'.repeat(22);
const id=n=>'v'+String(n).padStart(10,'0');
const channel=(cid=channelId,extra={})=>({id:cid,snippet:{title:'Example channel'},statistics:{subscriberCount:'123000',hiddenSubscriberCount:false,viewCount:'2000000',videoCount:'200'},contentDetails:{relatedPlaylists:{uploads:'UU'+cid.slice(2)}},...extra});
const video=(n,extra={})=>({id:id(n),snippet:{title:'Example video '+n,channelId,channelTitle:'Example channel',publishedAt:'2026-09-14T12:34:56Z',liveBroadcastContent:'none'},statistics:{viewCount:'12345',likeCount:'123',commentCount:'12'},contentDetails:{duration:'PT10M'},...extra});
const json=body=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
function fixture({videos=[video(1),video(2)],channels=[channel()],searchIds=videos.map(v=>v.id),uploads=videos.map(v=>v.id),hasMore=false}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const parsed=new URL(url),endpoint=parsed.pathname.split('/').at(-1),params=parsed.searchParams;
  assert.equal(parsed.origin,'https://www.googleapis.com');assert.equal(parsed.pathname,`/youtube/v3/${endpoint}`);
  assert.equal(params.get('key'),env.YOUTUBE_API_KEY);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  calls.push({endpoint,params,options});
  const page=items=>json({items,...(hasMore?{nextPageToken:'more'}:{})});
  if(endpoint==='search')return page(searchIds.map(value=>({id:{videoId:value}})));
  if(endpoint==='channels')return json({items:channels.filter(item=>params.get('id').split(',').includes(item.id))});
  if(endpoint==='videos')return json({items:videos.filter(item=>params.get('id').split(',').includes(item.id))});
  if(endpoint==='playlistItems'){assert.equal(params.get('playlistId'),'UU'+channelId.slice(2));return page(uploads.map(value=>({contentDetails:{videoId:value}})))}
  assert.fail('Unexpected endpoint');
 };
 return {fetchImpl,calls};
}
const collect=(options,f)=>collectYouTubeResearch({env,now,...options,fetchImpl:f.fetchImpl});

test('search enriches at most 50 metadata results and is always non-exhaustive',async()=>{
 const f=fixture(),r=await collect({operation:'search',query:' practical AI ',publishedAfter:'2026-09-01T01:00:00-05:00',order:'date'},f);
 assert.deepEqual(f.calls.map(c=>c.endpoint),['search','videos']);assert.equal(f.calls[0].params.get('q'),'practical AI');assert.equal(f.calls[0].params.get('maxResults'),'20');assert.equal(f.calls[0].params.get('publishedAfter'),'2026-09-01T06:00:00.000Z');assert.equal(f.calls[0].params.get('type'),'video');
 assert.equal(r.videos.length,2);assert.equal(r.videos[0].views,12345);assert.equal(r.videos[0].durationSeconds,600);assert.equal(r.videos[0].publishedAt,'2026-09-14T12:34:56.000Z');assert.equal(r.coverage.complete,false);assert.equal(r.coverage.hasMore,false);assert.match(r.coverage.warnings.join(' '),/non-exhaustive/);
 assert.match(r.limitations.join(' '),/no transcripts/);assert.equal(JSON.stringify(r).includes(env.YOUTUBE_API_KEY),false);
});

test('batch video requests deduplicate input, preserve requested ordering and mark missing videos',async()=>{
 const f=fixture(),r=await collect({operation:'videos',videoIds:[id(2),id(1),id(2),id(3)]},f);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].params.get('id'),[id(2),id(1),id(3)].join(','));
 assert.deepEqual(r.videos.map(v=>v.id),[id(2),id(1)]);assert.deepEqual(r.coverage.missingIds,[id(3)]);assert.equal(r.coverage.complete,false);assert.match(r.coverage.warnings.join(' '),/private or deleted/);
});

test('channel metadata keeps hidden subscribers unknown and public counts explicitly rounded',async()=>{
 const f=fixture({channels:[channel(),channel(otherChannel,{statistics:{hiddenSubscriberCount:true,subscriberCount:'50000',viewCount:'0'}})]});
 const r=await collect({operation:'channels',channelIds:[otherChannel,channelId]},f);
 assert.equal(r.channels[0].subscribers,null);assert.equal(r.channels[0].subscribersHidden,true);assert.equal(r.channels[0].subscriberCountPrecision,'unavailable');assert.equal(r.channels[0].lifetimeViews,0);assert.equal(r.channels[0].publicVideoCount,null);
 assert.equal(r.channels[1].subscribers,123000);assert.equal(r.channels[1].subscriberCountPrecision,'public-rounded');assert.equal(r.channels[1].uploadsPlaylistId,'UU'+channelId.slice(2));assert.equal(r.coverage.complete,true);
});

test('channel uploads uses only the matching uploads playlist and reports bounded coverage',async()=>{
 const f=fixture({hasMore:true}),r=await collect({operation:'channel_uploads',channelId},f);
 assert.deepEqual(f.calls.map(c=>c.endpoint),['channels','playlistItems','videos']);assert.equal(f.calls[1].params.get('maxResults'),'50');assert.equal(r.channels.length,1);assert.equal(r.videos.length,2);assert.equal(r.coverage.hasMore,true);assert.equal(r.coverage.complete,false);assert.match(r.coverage.warnings.join(' '),/older uploads/);
});

test('empty uploads/search are observations and do not trigger empty video API calls',async()=>{
 for(const operation of ['search','channel_uploads']){
  const f=fixture({videos:[]}),r=await collect({operation,...(operation==='search'?{query:'example'}:{channelId})},f);
  assert.deepEqual(r.videos,[]);assert.equal(r.coverage.complete,operation!=='search');assert.ok(f.calls.every(c=>c.endpoint!=='videos'));
 }
 const f=fixture({channels:[]});await assert.rejects(collect({operation:'channel_uploads',channelId},f),/channel was not found/);assert.equal(f.calls.length,1);
});

test('missing counts, dates, durations and live status stay null rather than being guessed',async()=>{
 const item=video(1,{statistics:{viewCount:'0',likeCount:'9007199254740992'},contentDetails:{duration:'not-duration'},snippet:{title:'Sparse video',channelId,publishedAt:'2026-02-31T12:00:00Z'}}),f=fixture({videos:[item]});
 const r=await collect({operation:'videos',videoIds:[id(1)]},f),v=r.videos[0];
 assert.equal(v.views,0);assert.equal(v.likes,null);assert.equal(v.comments,null);assert.equal(v.publishedAt,null);assert.equal(v.durationSeconds,null);assert.equal(v.format,'unknown');assert.equal(v.isLive,null);assert.equal(v.isLiveOrWasLive,null);assert.ok(r.coverage.warnings.length>=3);
});

test('live, upcoming and completed broadcasts remain distinct from ordinary uploads',async()=>{
 const live=(n,status,details)=>video(n,{snippet:{...video(n).snippet,liveBroadcastContent:status},liveStreamingDetails:details});
 const videos=[live(1,'live',{actualStartTime:'2026-09-15T16:00:00Z'}),live(2,'upcoming',{scheduledStartTime:'2026-09-16T16:00:00Z'}),live(3,'none',{actualStartTime:'2026-09-14T16:00:00Z',actualEndTime:'2026-09-14T17:00:00Z'}),video(4)];
 const r=await collect({operation:'videos',videoIds:videos.map(v=>v.id)},fixture({videos}));
 assert.deepEqual(r.videos.map(v=>v.isLive),[true,false,false,false]);assert.deepEqual(r.videos.map(v=>v.isUpcoming),[false,true,false,false]);assert.deepEqual(r.videos.map(v=>v.isLiveOrWasLive),[true,true,true,false]);assert.equal(r.videos[2].actualEndTime,'2026-09-14T17:00:00.000Z');
});

test('duration parsing includes day/hour units and the 180-second editorial boundary',async()=>{
 const videos=[video(1,{contentDetails:{duration:'PT3M'}}),video(2,{contentDetails:{duration:'PT3M0.5S'}}),video(3,{contentDetails:{duration:'P1DT2H3M4S'}}),video(4,{contentDetails:{duration:'P'}})];
 const r=await collect({operation:'videos',videoIds:videos.map(v=>v.id)},fixture({videos}));assert.deepEqual(r.videos.map(v=>v.durationSeconds),[180,180.5,93784,null]);assert.deepEqual(r.videos.map(v=>v.format),['short-form','long-form','long-form','unknown']);
});

test('unknown operations, irrelevant parameters and malformed requests fail before network access',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;assert.fail('must not fetch')};
 const bad=[{operation:'invalid'},{operation:'search',query:''},{operation:'search',query:'x'.repeat(201)},{operation:'search',query:'ok',order:'rating'},{operation:'search',query:'ok',maxResults:51},{operation:'search',query:'ok',maxResults:1.5},{operation:'search',query:'ok',maxResults:null},{operation:'search',query:'ok',channelId},{operation:'search',query:'ok',publishedAfter:'2026-02-31T00:00:00Z'},{operation:'search',query:'ok',publishedAfter:'yesterday'},{operation:'search',query:'ok',publishedAfter:'2026-01-01T99:00:00Z'},{operation:'videos',videoIds:[]},{operation:'videos',videoIds:['https://evil.invalid']},{operation:'videos',videoIds:Array(51).fill(id(1))},{operation:'videos',videoIds:[id(1)],maxResults:1},{operation:'channels',channelIds:['UU'+'a'.repeat(22)]},{operation:'channel_uploads',channelId:'https://evil.invalid'},{operation:'channel_uploads',channelId,query:'unused'},{operation:'search',query:'ok',url:'https://evil.invalid'}];
 for(const args of bad)await assert.rejects(collectYouTubeResearch({env,now,fetchImpl,...args}),/Invalid YouTube research request/);
 await assert.rejects(collectYouTubeResearch({operation:'videos',videoIds:[id(1)],fetchImpl}),/not configured/);
 await assert.rejects(collectYouTubeResearch({env,operation:'videos',videoIds:[id(1)],fetchImpl,now:'bad-date'}),/collection date/);
 assert.equal(calls,0);
});

test('HTTP/network/invalid JSON errors do not reveal credentials, URLs or bodies',async()=>{
 const phrase='PRIVATE RESPONSE '+env.YOUTUBE_API_KEY;
 for(const fetchImpl of [async()=>new Response(phrase,{status:403}),async()=>{throw Error('https://example.invalid/?key='+env.YOUTUBE_API_KEY)},async()=>new Response(phrase),async()=>json({items:'bad'})]){
  await assert.rejects(collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],fetchImpl}),error=>{assert.match(error.message,/YouTube/);assert.equal(error.message.includes(env.YOUTUBE_API_KEY),false);assert.equal(error.message.includes('PRIVATE RESPONSE'),false);assert.equal(error.message.includes('https://'),false);return true});
 }
});

test('mismatched, duplicate or malformed API resources fail closed',async()=>{
 const examples=[{items:[video(2)]},{items:[video(1),video(1)]},{items:[video(1,{snippet:{channelId:[channelId]}})]}];
 for(const body of examples)await assert.rejects(collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],fetchImpl:async()=>json(body)}),/invalid|did not match/i);
 const f=fixture({videos:[video(1,{snippet:{...video(1).snippet,channelId:otherChannel}})]});await assert.rejects(collect({operation:'channel_uploads',channelId},f),/did not match/);
 const wrong=fixture({channels:[channel(channelId,{contentDetails:{relatedPlaylists:{uploads:'https://evil.invalid'}}})]});await assert.rejects(collect({operation:'channel_uploads',channelId},wrong),/playlist did not match/);assert.equal(wrong.calls.length,1);
});

test('invalid playlist/search entries are skipped and repeated IDs do not duplicate metrics',async()=>{
 for(const operation of ['search','channel_uploads']){
  const f=fixture({searchIds:[id(1),'invalid',id(1)],uploads:[id(1),'invalid',id(1)]}),r=await collect({operation,...(operation==='search'?{query:'example'}:{channelId})},f);
  assert.deepEqual(r.videos.map(v=>v.id),[id(1)]);assert.equal(r.coverage.skippedEntries,1);assert.equal(r.coverage.complete,false);
 }
});

test('metadata text cannot echo the configured API credential',async()=>{
 const v=video(1);v.snippet.title=env.YOUTUBE_API_KEY;v.snippet.channelTitle='With '+env.YOUTUBE_API_KEY;
 const c=channel();c.snippet.title=env.YOUTUBE_API_KEY;
 for(const [options,f] of [[{operation:'videos',videoIds:[id(1)]},fixture({videos:[v]})],[{operation:'channels',channelIds:[channelId]},fixture({channels:[c]})]])assert.equal(JSON.stringify(await collect(options,f)).includes(env.YOUTUBE_API_KEY),false);
});

test('declared and streamed bodies are bounded to two megabytes, including multibyte text',async()=>{
 let chunks=0,cancelled=false;
 const body=new ReadableStream({pull(controller){chunks++;controller.enqueue(new Uint8Array(512*1024));},cancel(){cancelled=true;}});
 await assert.rejects(collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],fetchImpl:async()=>new Response(body)}),/size limit/);assert.ok(chunks<=6);assert.equal(cancelled,true);
 await assert.rejects(collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],fetchImpl:async()=>new Response('{}',{headers:{'content-length':String(3*1024*1024)}})}),/size limit/);
 await assert.rejects(collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],fetchImpl:async()=>new Response('é'.repeat(1024*1024+1))}),/size limit/);
});

test('pre-cancelled requests and in-flight cancellation do not wait on a hung fetch',async()=>{
 let called=false;
 await assert.rejects(collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],signal:AbortSignal.abort(),fetchImpl:async()=>{called=true;}}),/cancelled/);assert.equal(called,false);
 const controller=new AbortController();let received;
 const result=collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],signal:controller.signal,fetchImpl:async(_url,options)=>{received=options.signal;return new Promise(()=>{})}});
 controller.abort();await assert.rejects(result,/cancelled/);assert.equal(received.aborted,true);
});

test('a hung fetch has a ten-second deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const result=collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],fetchImpl:async()=>new Promise(()=>{})});
 t.mock.timers.tick(10000);await assert.rejects(result,/request timed out/);
});

test('a hung response body is cancelled at the request deadline',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let cancelled=false;
 const body=new ReadableStream({start(){},cancel(){cancelled=true;}});
 const result=collectYouTubeResearch({env,now,operation:'videos',videoIds:[id(1)],fetchImpl:async()=>new Response(body)});
 await new Promise(setImmediate);t.mock.timers.tick(10000);await assert.rejects(result,/request timed out/);assert.equal(cancelled,true);
});
