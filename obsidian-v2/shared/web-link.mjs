export function safeWebLink(value,hostname){
 if(typeof value!=='string'||/[\x00-\x20\x7f]/.test(value))return null;
 try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&(!hostname||url.hostname===hostname)?url.href:null}catch{return null}
}
