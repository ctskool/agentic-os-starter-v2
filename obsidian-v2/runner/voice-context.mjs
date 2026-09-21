import {AsyncLocalStorage} from 'node:async_hooks';
const scope=new AsyncLocalStorage();
export const withVoiceContext=(context,fn)=>scope.run(context,fn);
export function voiceContext(){const context=scope.getStore();if(!context)throw new Error('Voice request context is missing');return context}
export const recentExchanges=(count=6)=>(voiceContext().exchanges||[]).slice(-count);
