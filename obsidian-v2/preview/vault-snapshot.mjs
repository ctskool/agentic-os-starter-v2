import fs from 'node:fs';
import path from 'node:path';

const reportFolders=['inbox/research/github-trending','inbox/research/morning-intel','inbox/reports/morning','inbox/research/outlier-radar'];
// Match the native report reader's folder/children index without loading every
// report body. Daily frontmatter stays available to native component readers.
export function createPreviewSnapshot(root,{filesystem=fs}={}){
 const dailyCache=new Map();
 return ()=>{
  const out={},seen=new Set();
  for(const folder of ['daily-notes',...reportFolders]){
   const directory=path.join(root,folder);
   if(!filesystem.existsSync(directory))continue;
   for(const entry of filesystem.readdirSync(directory,{withFileTypes:true})){
    if(!entry.isFile()||!entry.name.endsWith('.md'))continue;
    const relative=`${folder}/${entry.name}`,file=path.join(directory,entry.name),stat=filesystem.statSync(file);
    const signature=`${stat.mtimeMs}:${stat.size}`;
    if(folder==='daily-notes'){
     seen.add(relative);
     let cached=dailyCache.get(relative);
     if(cached?.signature!==signature){cached={signature,text:filesystem.readFileSync(file,'utf8')};dailyCache.set(relative,cached)}
     out[relative]=cached.text;
    }else out[relative]=`\0preview-index:${signature}`;
   }
  }
  for(const key of dailyCache.keys())if(!seen.has(key))dailyCache.delete(key);
  return out;
 };
}
