const localServices=['http://127.0.0.1:3108','http://127.0.0.1:3220'];
// Spoken-only rendering at the shared TTS boundary. Keep the stored answer and
// diagram intact; verbalize direction rather than the name of the glyph.
export function spokenFlow(text){
 return text
  .replace(/\s*(?:<--?>|<=>|[↔⇔⟷])\s*/g,' to and from ')
  .replace(/\s*[←⇐⟵]\s*/g,' from ')
  .replace(/\s*[,;]?\s*(?<![<=-])(?:-->|->|==>|=>|[→⇒⟶⟹➜➔➡]\uFE0F?)\s*(?:then\s+)?/gi,', then ');
}
export async function resolveSpeechService(configured,request=fetch){
 if(configured){
  if(!localServices.includes(configured))throw new Error('Speech must use the local Jarvis or V2 service.');
  return configured;
 }
 // A bridge restart must reuse the existing healthy service, not silently
 // switch to an unused port or start a second speech/GPU process.
 for(const url of localServices){
  try{const response=await request(url+'/health',{signal:AbortSignal.timeout(2000)});if(response.ok){const health=await response.json();if(health.ok&&health.stt?.ok)return url}}catch{}
 }
 return localServices[1];
}
