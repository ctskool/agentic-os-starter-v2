import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
export const projectRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function configuredVault(){
 if(process.env.AOS_V2_VAULT)return process.env.AOS_V2_VAULT;
 const file=path.join(projectRoot,'.runtime/vault.json');
 return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).vault:path.join(projectRoot,'test-vault');
}
