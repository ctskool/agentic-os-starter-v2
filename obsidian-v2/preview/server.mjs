import {configuredVault} from '../runner/runtime.mjs';
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import {fileURLToPath} from 'node:url';import esbuild from 'esbuild';
import {assertVault,vaultPath} from '../runner/core.mjs';
import {readBridgeToken,acceptsBridgeToken} from '../runner/bridge-auth.mjs';
import {allowsAuthBootstrap} from '../shared/auth-origin.mjs';
import {createPreviewSnapshot} from './vault-snapshot.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url))),root=assertVault(configuredVault());
await esbuild.build({entryPoints:[path.join(base,'preview/entry.tsx')],bundle:true,loader:{'.css':'text'},format:'esm',target:'es2022',outfile:path.join(base,'preview/bundle.js'),jsx:'automatic',jsxImportSource:'preact',alias:{obsidian:path.join(base,'preview/obsidian.ts')},minify:true});
const writable=p=>/^system\/v2\/(provider\.json|queue\/[a-f0-9-]+\.(pending|json))$/.test(p)||/^daily-notes\/\d{4}-\d{2}-\d{2}\.md$/.test(p);
const snapshot=createPreviewSnapshot(root);
const server=http.createServer(async(req,res)=>{
 try{
  if(req.headers.host!=='127.0.0.1:3218')throw new Error('Invalid host');
  const url=new URL(req.url,'http://127.0.0.1:3218');
  if(req.method==='GET'&&url.pathname==='/bridge-auth'){
   const request=new Request(url,{headers:req.headers});
   if(!allowsAuthBootstrap(request,3218)){res.writeHead(403,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Origin not allowed'}));return}
   const token=readBridgeToken(path.join(base,'.runtime'));res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({token}));return;
  }
  if(req.method==='POST'&&url.pathname==='/rpc'){
   if(req.headers.origin && req.headers.origin!=='http://127.0.0.1:3218')throw new Error('Invalid origin');
   if(req.headers['sec-fetch-site']==='cross-site')throw new Error('Invalid site');
   if(!acceptsBridgeToken(req.method,req.headers,readBridgeToken(path.join(base,'.runtime')))){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Bridge authentication required'}));return}
   let body='';for await(const b of req){body+=b;if(body.length>100000)throw new Error('Request too large')}
   const data=JSON.parse(body);const p=data.path?vaultPath(root,data.path):root;let result;
   switch(data.op){
    case 'snapshot':result=snapshot();break;
    case 'exists':result=fs.existsSync(p);break;
    case 'read':result=fs.readFileSync(p,'utf8');break;
    case 'list':{const names=fs.readdirSync(p,{withFileTypes:true});result={files:names.filter(n=>n.isFile()).map(n=>data.path+'/'+n.name),folders:names.filter(n=>n.isDirectory()).map(n=>data.path+'/'+n.name)};break}
    case 'mkdir':if(data.path!=='system/v2/queue')throw new Error('Write outside allowed paths');fs.mkdirSync(p,{recursive:true});result=null;break;
    case 'write':if(!writable(data.path))throw new Error('Write outside allowed paths');fs.writeFileSync(p,data.text);result=null;break;
    case 'rename':if(!writable(data.path)||!writable(data.to))throw new Error('Write outside allowed paths');fs.renameSync(p,vaultPath(root,data.to));result=null;break;
    default:throw new Error('Unknown operation');
   }
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({result}));return;
  }
  if(url.pathname.startsWith('/assets/')){
   const file=vaultPath(path.join(base,'assets'),decodeURIComponent(url.pathname.slice(8)));
   if(!/\.(png|woff2)$/.test(file))throw new Error('Unsupported asset');
   res.writeHead(200,{'Content-Type':file.endsWith('.png')?'image/png':'font/woff2'});res.end(fs.readFileSync(file));return;
  }
  const staticFiles={'/': ['preview/index.html','text/html'],'/bundle.js':['preview/bundle.js','text/javascript'],'/styles.css':['styles.css','text/css']};
  const entry=staticFiles[url.pathname];if(!entry){res.writeHead(404);res.end();return}
  res.writeHead(200,{'Content-Type':entry[1],'Cache-Control':'no-store'});res.end(fs.readFileSync(path.join(base,entry[0])));
 }catch(e){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}
});
server.listen(3218,'127.0.0.1',()=>console.log('Obsidian V2 component preview: http://127.0.0.1:3218'));
