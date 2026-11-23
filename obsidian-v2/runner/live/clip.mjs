export function clip(value,size=160){
 const text=String(value??'').replace(/\s+/g,' ').trim();
 if(Buffer.byteLength(text)<=size)return text;
 const ellipsis='…';
 let end=0,bytes=Buffer.byteLength(ellipsis);
 if(bytes>size)return '';
 for(const word of text.matchAll(/\S+/g)){
  bytes+=Buffer.byteLength(word[0])+(end?1:0);
  if(bytes>size)break;
  end=word.index+word[0].length;
 }
 return text.slice(0,end)+ellipsis;
}
// OpenAI rejects a context append over 500 tokens. Checked on a real call 2026-11-23: number-dense text passed at
// 1,400 bytes and failed at 1,900 ("Context append text must not exceed 500 tokens"), so 1,000 leaves room for denser text.
export const APPEND_MAX_BYTES=1000;
// A section that is too long for one append goes in parts, split at line ends, each carrying the section's header.
export function appendParts(section,limit=APPEND_MAX_BYTES){
 const text=String(section??'');
 if(Buffer.byteLength(text)<=limit)return [text];
 const [first,...rows]=text.split('\n'),header=clip(first,Math.floor(limit/3)),again=header+' (continued)',room=limit-Buffer.byteLength(again)-1;
 const parts=[];let current=header;
 for(const row of rows){
  const line=Buffer.byteLength(row)>room?clip(row,room):row;
  if(Buffer.byteLength(current)+1+Buffer.byteLength(line)>limit){parts.push(current);current=again+'\n'+line}
  else current+='\n'+line;
 }
 parts.push(current);
 return parts;
}
