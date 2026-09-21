export function previewFile(relative){
 const name=relative.split('/').at(-1),extension=name.includes('.')?name.split('.').at(-1):'';
 return {path:relative,name,basename:extension?name.slice(0,-extension.length-1):name,extension};
}
export function previewAbstractFile(cache,relative){
 if(Object.hasOwn(cache,relative))return previewFile(relative);
 const prefix=relative.replace(/\/$/,'')+'/',children=Object.keys(cache).filter(key=>key.startsWith(prefix)&&!key.slice(prefix.length).includes('/')).map(previewFile);
 return children.length?{path:relative,name:relative.split('/').at(-1),children}:null;
}
