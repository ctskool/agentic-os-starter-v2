// Trusted, read-only metadata access. Credentials go only to the Data API,
// never to model-visible tool results, prompts or reports.
// https://developers.google.com/youtube/v3/docs/search/list
// https://developers.google.com/youtube/v3/docs/videos/list
// https://developers.google.com/youtube/v3/docs/channels/list
// https://developers.google.com/youtube/v3/docs/playlistItems/list
const BASE='https://www.googleapis.com/youtube/v3/';
const CHANNEL=/^UC[A-Za-z0-9_-]{22}$/,VIDEO=/^[A-Za-z0-9_-]{11}$/;
const MAX_BODY=2*1024*1024;
const OPERATIONS={search:['query','publishedAfter','order','maxResults'],videos:['videoIds'],channels:['channelIds'],channel_uploads:['channelId','maxResults']};
const invalid=()=>new Error('Invalid YouTube research request.');
const count=value=>{if((typeof value!=='string'&&!Number.isInteger(value))||!/^\d+$/.test(String(value)))return null;const n=Number(value);return Number.isSafeInteger(n)&&n>=0?n:null};
function timestamp(value){
 if(typeof value!=='string')return null;
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
 if(!match)return null;
 const [,year,month,day,hour,minute,second,offset]=match;
 const civil=new Date(`${year}-${month}-${day}T00:00:00Z`);
 if(!Number.isFinite(civil.getTime())||civil.toISOString().slice(0,10)!==`${year}-${month}-${day}`||+hour>23||+minute>59||+second>59||offset!=='Z'&&(+offset.slice(1,3)>23||+offset.slice(4)>59))return null;
 const parsed=Date.parse(value);return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}
function duration(value){
 if(typeof value!=='string')return null;
 const match=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
 if(!match||!match.slice(1).some(part=>part!==undefined))return null;
 const n=Number(match[1]||0)*86400+Number(match[2]||0)*3600+Number(match[3]||0)*60+Number(match[4]||0);
 return Number.isSafeInteger(Math.floor(n))&&n>=0?n:null;
}
function list(body,max){if(!body||!Array.isArray(body.items)||body.items.length>max)throw new Error('The YouTube Data API returned an invalid response.');return body.items}
function ids(value,pattern){if(!Array.isArray(value)||value.length<1||value.length>50||value.some(id=>typeof id!=='string'||!pattern.test(id)))throw invalid();return [...new Set(value)]}
function hasMore(body){if(body.nextPageToken===undefined||body.nextPageToken==='')return false;if(typeof body.nextPageToken!=='string'||body.nextPageToken.length>4096)throw new Error('The YouTube Data API returned invalid pagination.');return true}

export async function collectYouTubeResearch({env={},operation,query,videoIds,channelIds,channelId,publishedAfter,order,maxResults,fetchImpl=fetch,now=new Date(),signal,...unknown}={}){
 if(Object.keys(unknown).length||!Object.hasOwn(OPERATIONS,operation))throw invalid();
 const supplied={query,videoIds,channelIds,channelId,publishedAfter,order,maxResults};
 if(Object.entries(supplied).some(([key,value])=>value!==undefined&&!OPERATIONS[operation].includes(key)))throw invalid();
 let requestedIds=[],limit,after;
 if(operation==='search'){
  if(typeof query!=='string'||query.trim().length<1||query.length>200||/[\x00-\x1f\x7f]/.test(query))throw invalid();
  if(order!==undefined&&!['date','viewCount','relevance'].includes(order))throw invalid();
  if(publishedAfter!==undefined&&!(after=timestamp(publishedAfter)))throw invalid();
 }
 if(operation==='search'||operation==='channel_uploads'){
  limit=maxResults??(operation==='search'?20:50);
  if(maxResults===null||!Number.isInteger(limit)||limit<1||limit>50)throw invalid();
 }
 if(operation==='videos')requestedIds=ids(videoIds,VIDEO);
 if(operation==='channels')requestedIds=ids(channelIds,CHANNEL);
 if(operation==='channel_uploads'&&(typeof channelId!=='string'||!CHANNEL.test(channelId)))throw invalid();
 const apiKey=env?.YOUTUBE_API_KEY;
 if(typeof apiKey!=='string'||!apiKey.trim())throw new Error('YouTube API access is not configured. Set YOUTUBE_API_KEY for the local integration.');
 const asOf=new Date(now);if(!Number.isFinite(asOf.getTime()))throw new Error('Invalid YouTube collection date.');
 if(signal?.aborted)throw new Error('YouTube research cancelled.');
 const clean=(value,max=500)=>typeof value==='string'?value.replaceAll(apiKey,'[redacted]').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,max):'';
 const overall=new AbortController(),totalTimer=setTimeout(()=>overall.abort(),30000);totalTimer.unref?.();
 const warnings=new Set();let requests=0;
 async function get(endpoint,params){
  if(!['search','videos','channels','playlistItems'].includes(endpoint))throw invalid();
  const request=new AbortController(),timer=setTimeout(()=>request.abort(),10000);timer.unref?.();
  const combined=AbortSignal.any([overall.signal,request.signal,...(signal?[signal]:[])]);
  const abortError=()=>new Error(signal?.aborted?'YouTube research cancelled.':overall.signal.aborted?'YouTube research exceeded its 30-second limit.':'The YouTube Data API request timed out.');
  let onAbort,reader;
  const failure=new Promise((_,reject)=>{onAbort=()=>reject(abortError());combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort()});
  try{
   if(combined.aborted)return await failure;
   const url=new URL(endpoint,BASE);for(const [key,value]of Object.entries({...params,key:apiKey}))url.searchParams.set(key,value);
   requests++;
   const work=(async()=>{
    let response;try{response=await fetchImpl(url.toString(),{method:'GET',headers:{Accept:'application/json'},redirect:'error',signal:combined})}catch{if(combined.aborted)throw abortError();throw new Error('Could not reach the YouTube Data API.')}
    if(combined.aborted)throw abortError();
    if(!response?.ok)throw new Error(`The YouTube Data API request failed (HTTP ${Number.isInteger(response?.status)?response.status:'unknown'}).`);
    if(response.redirected)throw new Error('The YouTube Data API returned an unexpected redirect.');
    if(Number(response.headers?.get('content-length')||0)>MAX_BODY)throw new Error('The YouTube Data API response exceeded its size limit.');
    let text='';
    try{
     if(response.body?.getReader){
      reader=response.body.getReader();const decoder=new TextDecoder();let bytes=0;
      while(true){const chunk=await reader.read();if(combined.aborted)throw abortError();if(chunk.done)break;if(!(chunk.value instanceof Uint8Array))throw new Error('invalid body');bytes+=chunk.value.byteLength;if(bytes>MAX_BODY)throw new Error('oversized');text+=decoder.decode(chunk.value,{stream:true})}text+=decoder.decode();
     }else{text=await response.text();if(Buffer.byteLength(text,'utf8')>MAX_BODY)throw new Error('oversized')}
    }catch(error){if(combined.aborted)throw abortError();if(error?.message==='oversized')throw new Error('The YouTube Data API response exceeded its size limit.');throw new Error('Could not read the YouTube Data API response.')}
    try{return JSON.parse(text)}catch{throw new Error('The YouTube Data API returned invalid JSON.')}
   })();
   return await Promise.race([work,failure]);
  }finally{clearTimeout(timer);combined.removeEventListener('abort',onAbort);if(reader)try{void reader.cancel().catch(()=>{})}catch{}}
 }
 function video(item){
  if(!item||typeof item.id!=='string'||!VIDEO.test(item.id)||typeof item.snippet?.channelId!=='string'||!CHANNEL.test(item.snippet.channelId))throw new Error('The YouTube Data API returned invalid video metadata.');
  const snippet=item.snippet,stats=item.statistics||{},live=item.liveStreamingDetails;
  const publishedAt=timestamp(snippet.publishedAt),durationSeconds=duration(item.contentDetails?.duration);
  const broadcast=['none','live','upcoming'].includes(snippet.liveBroadcastContent)?snippet.liveBroadcastContent:null;
  const hasLiveDetails=!!live&&typeof live==='object'&&!Array.isArray(live);
  if(!publishedAt)warnings.add('Some exact publication timestamps were unavailable.');
  if(durationSeconds===null)warnings.add('Some durations were unavailable; those videos cannot be classified by duration.');
  if(broadcast===null&&!hasLiveDetails)warnings.add('Some live-broadcast status was unavailable.');
  const values={views:count(stats.viewCount),likes:count(stats.likeCount),comments:count(stats.commentCount)};
  if(Object.values(values).includes(null))warnings.add('Some public counts were unavailable and remain null, not zero.');
  return {id:clean(item.id),url:clean(`https://www.youtube.com/watch?v=${item.id}`),title:clean(snippet.title)||'Untitled video',channelId:clean(snippet.channelId),channelTitle:clean(snippet.channelTitle),publishedAt,durationSeconds,format:durationSeconds===null?'unknown':durationSeconds<=180?'short-form':'long-form',...values,liveBroadcastContent:broadcast,isLive:broadcast===null?hasLiveDetails&&timestamp(live.actualStartTime)&&!timestamp(live.actualEndTime)?true:null:broadcast==='live',isUpcoming:broadcast===null?null:broadcast==='upcoming',isLiveOrWasLive:hasLiveDetails||broadcast==='live'||broadcast==='upcoming'?true:broadcast==='none'?false:null,scheduledStartTime:timestamp(live?.scheduledStartTime),actualStartTime:timestamp(live?.actualStartTime),actualEndTime:timestamp(live?.actualEndTime)};
 }
 function channel(item){
  if(!item||typeof item.id!=='string'||!CHANNEL.test(item.id))throw new Error('The YouTube Data API returned invalid channel metadata.');
  const stats=item.statistics||{},hidden=typeof stats.hiddenSubscriberCount==='boolean'?stats.hiddenSubscriberCount:null;
  const uploads=item.contentDetails?.relatedPlaylists?.uploads;
  if(uploads!==undefined&&uploads!=='UU'+item.id.slice(2))throw new Error('The YouTube uploads playlist did not match its channel.');
  const subscribers=hidden===true?null:count(stats.subscriberCount);
  if(subscribers===null)warnings.add('Some public subscriber counts were hidden or unavailable.');
  return {id:clean(item.id),url:clean(`https://www.youtube.com/channel/${item.id}`),title:clean(item.snippet?.title)||'Untitled channel',uploadsPlaylistId:uploads===undefined?null:clean(uploads),subscribers,subscribersHidden:hidden,subscriberCountPrecision:subscribers===null?'unavailable':'public-rounded',lifetimeViews:count(stats.viewCount),publicVideoCount:count(stats.videoCount)};
 }
 async function fetchVideos(wanted,expectedChannel){
  if(!wanted.length)return [];
  const body=await get('videos',{part:'snippet,statistics,contentDetails,liveStreamingDetails',id:wanted.join(',')}),found=new Map();
  for(const item of list(body,wanted.length)){if(!wanted.includes(item?.id)||found.has(item.id)||expectedChannel&&item.snippet?.channelId!==expectedChannel)throw new Error('The YouTube video response did not match the requested videos.');found.set(item.id,video(item))}
  return wanted.map(id=>found.get(id)).filter(Boolean);
 }
 async function fetchChannels(wanted){
  const body=await get('channels',{part:'snippet,statistics,contentDetails',id:wanted.join(','),maxResults:String(wanted.length)}),found=new Map();
  for(const item of list(body,wanted.length)){if(!wanted.includes(item?.id)||found.has(item.id))throw new Error('The YouTube channel response did not match the requested channels.');found.set(item.id,channel(item))}
  return wanted.map(id=>found.get(id)).filter(Boolean);
 }
 try{
  let videos=[],channels=[],more=false,skippedEntries=0,availableIds=[];
  if(operation==='videos'){videos=await fetchVideos(requestedIds);availableIds=videos.map(v=>v.id)}
  else if(operation==='channels'){channels=await fetchChannels(requestedIds);availableIds=channels.map(c=>c.id)}
  else if(operation==='search'){
   const body=await get('search',{part:'snippet',type:'video',q:query.trim(),order:order||'relevance',maxResults:String(limit),...(after?{publishedAfter:after}:{})});more=hasMore(body);
   for(const item of list(body,limit)){const id=item?.id?.videoId;if(typeof id!=='string'||!VIDEO.test(id)){skippedEntries++;continue}if(!requestedIds.includes(id))requestedIds.push(id)}
   videos=await fetchVideos(requestedIds);availableIds=videos.map(v=>v.id);
   warnings.add('Search is an indexed, non-exhaustive sample even when no additional page is available.');
   if(more)warnings.add('Search results are a bounded sample; additional matches exist.');
  }else{
   channels=await fetchChannels([channelId]);
   if(!channels.length)throw new Error('The requested YouTube channel was not found.');
   if(!channels[0].uploadsPlaylistId)throw new Error('The requested channel uploads playlist was unavailable.');
   const body=await get('playlistItems',{part:'contentDetails,snippet',playlistId:'UU'+channelId.slice(2),maxResults:String(limit)});more=hasMore(body);
   for(const item of list(body,limit)){const id=item?.contentDetails?.videoId||item?.snippet?.resourceId?.videoId;if(typeof id!=='string'||!VIDEO.test(id)){skippedEntries++;continue}if(!requestedIds.includes(id))requestedIds.push(id)}
   videos=await fetchVideos(requestedIds,channelId);availableIds=videos.map(v=>v.id);
   if(more)warnings.add('Only the first requested uploads were collected; older uploads exist.');
  }
  const missingIds=requestedIds.filter(id=>!availableIds.includes(id));
  if(missingIds.length)warnings.add('Some requested resources were unavailable, private or deleted; they were not treated as zero.');
  if(skippedEntries)warnings.add('Some source entries lacked usable video IDs and were skipped.');
  return {schemaVersion:1,operation,source:'YouTube Data API v3',collectedAt:asOf.toISOString(),videos,channels,coverage:{requests,requested:requestedIds.length,returned:availableIds.length,missingIds:missingIds.map(id=>clean(id)),skippedEntries,hasMore:more,complete:operation!=='search'&&!more&&!missingIds.length&&!skippedEntries,warnings:[...warnings]},limitations:['Metadata only: no transcripts, captions or content analysis were collected.','Views, likes and comments are lifetime-to-collection counts, not period analytics. Public subscriber counts may be rounded.','Short-form means duration at most 180 seconds for editorial analysis; it is not an official YouTube format label.','No CTR, retention, watch time, subscriber gains or prior-period growth were collected.']};
 }finally{clearTimeout(totalTimer)}
}
