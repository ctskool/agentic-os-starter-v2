// Read-only Data API collection. Credentials stay inside this trusted helper.
// API contracts: https://developers.google.com/youtube/v3/docs/channels/list
// https://developers.google.com/youtube/v3/docs/playlistItems/list
// https://developers.google.com/youtube/v3/docs/videos/list
import {TIME_ZONE} from '../shared/timezone.mjs';
const ZONE=TIME_ZONE,BASE='https://www.googleapis.com/youtube/v3/';
const CHANNEL=/^UC[A-Za-z0-9_-]{22}$/,VIDEO=/^[A-Za-z0-9_-]{11}$/;
const MAX_PAGES=10,MAX_BODY=2*1024*1024;
const localDate=date=>new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const shiftDate=(date,days)=>{const value=new Date(date+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)};
function midnight(date){
 const target=Date.parse(date+'T00:00:00Z');let guess=target;
 const format=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 for(let i=0;i<3;i++){const parts=Object.fromEntries(format.formatToParts(new Date(guess)).map(part=>[part.type,part.value]));const local=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));guess+=target-local}
 return guess;
}
function count(value){if(typeof value!=='string'&&!Number.isInteger(value)||!/^\d+$/.test(String(value)))return null;const number=Number(value);return Number.isSafeInteger(number)&&number>=0?number:null}
function publication(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value))return NaN;
 const parsed=Date.parse(value);return Number.isFinite(parsed)&&new Date(parsed).toISOString().slice(0,19)===value.slice(0,19)?parsed:NaN;
}
function duration(value){
 if(typeof value!=='string')return null;
 const match=/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
 if(!match)return null;
 const seconds=Number(match[1]||0)*86400+Number(match[2]||0)*3600+Number(match[3]||0)*60+Number(match[4]||0);
 return Number.isFinite(seconds)&&seconds>0?seconds:null;
}
const median=values=>{const sorted=values.filter(value=>value!==null&&Number.isFinite(value)).sort((a,b)=>a-b);return sorted.length?sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2:null};
function items(body,max){if(!body||!Array.isArray(body.items)||body.items.length>max)throw new Error('The YouTube Data API returned an invalid response.');return body.items}

export async function collectYouTubeReview({env={},fetchImpl=fetch,now=new Date(),signal}={}){
 const apiKey=env.YOUTUBE_API_KEY,channelId=env.YOUTUBE_CHANNEL_ID;
 if(typeof apiKey!=='string'||!apiKey.trim())throw new Error('YouTube API access is not configured. Set YOUTUBE_API_KEY for the local integration.');
 if(typeof channelId!=='string'||!CHANNEL.test(channelId))throw new Error('A valid YOUTUBE_CHANNEL_ID is required for the local integration.');
 const asOf=new Date(now);if(!Number.isFinite(asOf.getTime()))throw new Error('Invalid YouTube collection date.');
 if(signal?.aborted)throw new Error('YouTube review cancelled.');
 const today=localDate(asOf),startDate=shiftDate(today,-7),endDate=shiftDate(today,-1),startMs=midnight(startDate),endMs=midnight(today);
 const overall=new AbortController(),totalTimer=setTimeout(()=>overall.abort(),60000);totalTimer.unref?.();
 const warnings=new Set(),clean=(value,max=500)=>typeof value==='string'?value.replaceAll(apiKey,'[redacted]').slice(0,max):'';
 async function get(endpoint,params){
  const request=new AbortController(),timer=setTimeout(()=>request.abort(),10000);timer.unref?.();
  const combined=AbortSignal.any([overall.signal,request.signal,...(signal?[signal]:[])]);
  const aborted=()=>new Error(signal?.aborted?'YouTube review cancelled.':overall.signal.aborted?'YouTube review exceeded its 60-second limit.':'The YouTube Data API request timed out.');
  let onAbort;
  const failure=new Promise((_,reject)=>{onAbort=()=>reject(aborted());combined.addEventListener('abort',onAbort,{once:true});if(combined.aborted)onAbort()});
  try{
   if(combined.aborted)return await failure;
   const url=new URL(endpoint,BASE);for(const [key,value] of Object.entries({...params,key:apiKey}))url.searchParams.set(key,value);
   const work=(async()=>{
    let response;
    try{response=await fetchImpl(url.toString(),{method:'GET',headers:{Accept:'application/json'},redirect:'error',signal:combined})}catch{if(combined.aborted)throw aborted();throw new Error('Could not reach the YouTube Data API.')}
    if(!response?.ok)throw new Error(`The YouTube Data API request failed (HTTP ${Number.isInteger(response?.status)?response.status:'unknown'}).`);
    const declared=Number(response.headers?.get('content-length')||0);if(declared>MAX_BODY)throw new Error('The YouTube Data API response exceeded its size limit.');
    let text;try{text=await response.text()}catch{if(combined.aborted)throw aborted();throw new Error('Could not read the YouTube Data API response.')}
    if(text.length>MAX_BODY)throw new Error('The YouTube Data API response exceeded its size limit.');
    try{return JSON.parse(text)}catch{throw new Error('The YouTube Data API returned invalid JSON.')}
   })();
   return await Promise.race([work,failure]);
  }finally{clearTimeout(timer);combined.removeEventListener('abort',onAbort)}
 }
 try{
  const channelItems=items(await get('channels',{part:'snippet,statistics,contentDetails',id:channelId,fields:'items(id,snippet(title),statistics,contentDetails/relatedPlaylists/uploads)'}),1);
  const channel=channelItems[0];if(!channel||channel.id!==channelId)throw new Error('The configured YouTube channel was not found.');
  const playlist='UU'+channelId.slice(2),returnedPlaylist=channel.contentDetails?.relatedPlaylists?.uploads;
  if(returnedPlaylist&&returnedPlaylist!==playlist)throw new Error('The YouTube uploads playlist did not match the configured channel.');
  const videos=new Map(),seenIds=new Set(),orderedIds=new Set(),tokens=new Set();let pageToken='',pages=0,uploadsSeen=0,missingVideos=0,unknownDuration=0,unknownDates=0,olderSeen=false,ordered=true,previous=Infinity,exhausted=false,stoppedAfterCoverage=false;
  while(pages<MAX_PAGES){
   const page=await get('playlistItems',{part:'contentDetails,snippet',playlistId:playlist,maxResults:'50',fields:'nextPageToken,items(contentDetails(videoId,videoPublishedAt),snippet(resourceId/videoId,publishedAt))',...(pageToken?{pageToken}:{})});pages++;
   const entries=items(page,50);uploadsSeen+=entries.length;
   const ids=[];
   for(const entry of entries){const id=entry?.contentDetails?.videoId||entry?.snippet?.resourceId?.videoId;if(!VIDEO.test(id||'')){warnings.add('Some playlist entries had no usable video ID.');unknownDates++;continue}if(!seenIds.has(id)){seenIds.add(id);ids.push(id)}}
   const fetched=new Map();
   if(ids.length){
    const response=await get('videos',{part:'snippet,statistics,contentDetails',id:ids.join(','),fields:'items(id,snippet(title,publishedAt,channelId),statistics(viewCount,likeCount,commentCount),contentDetails/duration)'});
    for(const item of items(response,ids.length)){
     if(!ids.includes(item?.id)||fetched.has(item.id)||item.snippet?.channelId&&item.snippet.channelId!==channelId)throw new Error('The YouTube video response did not match the configured channel uploads.');
     fetched.set(item.id,item);
    }
    missingVideos+=ids.filter(id=>!fetched.has(id)).length;
   }
   for(const entry of entries){
    const id=entry?.contentDetails?.videoId||entry?.snippet?.resourceId?.videoId;if(!VIDEO.test(id||''))continue;
    if(orderedIds.has(id))continue;orderedIds.add(id);
    const item=fetched.get(id),known=videos.get(id);
    const published=publication(item?.snippet?.publishedAt||known?.publishedAt||entry?.contentDetails?.videoPublishedAt||'');
    if(!Number.isFinite(published)){unknownDates++;continue}
    if(published>previous)ordered=false;previous=published;
    if(published<startMs)olderSeen=true;
    if(!item||known)continue;
    if(published>asOf.getTime()){warnings.add('Future-dated uploads were excluded.');continue}
    const seconds=duration(item.contentDetails?.duration);
    if(seconds===null)unknownDuration++;
    videos.set(id,{id,title:clean(item.snippet?.title)||'Untitled video',url:`https://www.youtube.com/watch?v=${id}`,publishedAt:new Date(published).toISOString(),durationSeconds:seconds,format:seconds===null?'unknown':seconds<=180?'short-form':'long-form',views:count(item.statistics?.viewCount),likes:count(item.statistics?.likeCount),comments:count(item.statistics?.commentCount),ageHours:Math.max(0,(asOf.getTime()-published)/3600000)});
   }
   const next=page.nextPageToken;
   if(next===undefined||next===''){exhausted=true;break}
   if(typeof next!=='string'||next.length>4096||tokens.has(next))throw new Error('The YouTube Data API returned invalid pagination.');
   tokens.add(next);pageToken=next;
   if(olderSeen&&ordered&&unknownDates===0&&[...videos.values()].filter(video=>video.format==='long-form').length>=10){stoppedAfterCoverage=true;break}
  }
  const sorted=[...videos.values()].sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)),baselineVideos=sorted.filter(video=>video.format==='long-form').slice(0,10);
  const views=baselineVideos.map(video=>video.views),likes=baselineVideos.map(video=>video.likes),engagement=baselineVideos.map(video=>video.views>0&&video.likes!==null&&video.comments!==null?(video.likes+video.comments)/video.views:null);
  const baselineViews=median(views),weekly=sorted.filter(video=>Date.parse(video.publishedAt)>=startMs&&Date.parse(video.publishedAt)<endMs);
  const score=video=>{
   const ratio=video.views!==null&&baselineViews>0?video.views/baselineViews*100:null;
   return {...video,viewsPercentOfBaseline:ratio===null?null:Math.round(ratio*10)/10,verdict:video.ageHours<24?'Climbing':ratio===null?'Unavailable':ratio>=150?'Hit':ratio>=60?'Steady':'Miss'};
  };
  if(missingVideos)warnings.add(`${missingVideos} playlist videos were unavailable or private; they were not treated as zero.`);
  if(unknownDuration)warnings.add(`${unknownDuration} videos had unavailable durations and were excluded from format buckets and the baseline.`);
  if(unknownDates)warnings.add('Some publication dates were unavailable; weekly coverage may be incomplete.');
  if(!ordered)warnings.add('Uploads were not returned in publication order; collection continued to the end or page limit.');
  if(!exhausted&&!stoppedAfterCoverage)warnings.add('The 500-upload collection limit was reached before full coverage was confirmed.');
  if(baselineVideos.length<10)warnings.add(`Only ${baselineVideos.length} long-form videos were available for the ten-video baseline.`);
  if(sorted.some(video=>[video.views,video.likes,video.comments].includes(null)))warnings.add('Some public counts were unavailable; missing counts remain null and are omitted from their metric medians.');
  const statistics=channel.statistics||{};
  return {
   schemaVersion:1,source:'YouTube Data API v3',collectedAt:asOf.toISOString(),
   channel:{id:channelId,title:clean(channel.snippet?.title)||'Configured channel',snapshot:{subscribers:statistics.hiddenSubscriberCount?null:count(statistics.subscriberCount),lifetimeViews:count(statistics.viewCount),publicVideoCount:count(statistics.videoCount),asOf:asOf.toISOString(),note:'Public snapshot totals; subscriber counts may be rounded. Lifetime views are not seven-day or 28-day views.'}},
   window:{timeZone:ZONE,startDate,endDate,startInclusive:new Date(startMs).toISOString(),endExclusive:new Date(endMs).toISOString(),note:'Seven completed '+(ZONE==='America/Chicago'?'Chicago':ZONE)+' calendar dates; today is excluded.'},
   weekly:{longForm:weekly.filter(video=>video.format==='long-form').map(score),shortForm:weekly.filter(video=>video.format==='short-form'),unclassified:weekly.filter(video=>video.format==='unknown')},
   baseline:{definition:'The ten most recent available long-form uploads as of collection, including uploads in the review window and today if present.',sampleSize:baselineVideos.length,videos:baselineVideos,medianViews:baselineViews,medianLikes:median(likes),medianEngagement:median(engagement),metricSampleSizes:{views:views.filter(value=>value!==null).length,likes:likes.filter(value=>value!==null).length,engagement:engagement.filter(value=>value!==null).length}},
   coverage:{pages,playlistEntriesSeen:uploadsSeen,videosAvailable:videos.size,unavailableVideos:missingVideos,paginationCoveredWindow:exhausted||stoppedAfterCoverage,windowComplete:(exhausted||stoppedAfterCoverage)&&unknownDates===0&&missingVideos===0,baselineComplete:baselineVideos.length===10&&unknownDuration===0&&unknownDates===0&&missingVideos===0,playlistExhausted:exhausted,warnings:[...warnings]},
   limitations:['Views, likes and comments are lifetime-to-collection counts on those uploads, not period channel analytics.','Short-form means duration at most 180 seconds for this editorial report; it is not an official YouTube format label.','No CTR, retention, watch time, subscriber gains, prior-week deltas or 28-day views were collected.']
  };
 }finally{clearTimeout(totalTimer)}
}
