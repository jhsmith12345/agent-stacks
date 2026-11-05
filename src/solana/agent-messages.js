import {randomUUID} from 'node:crypto';
// Correlate IPC replies so an expired approval cannot satisfy a later request.
export function ask(child,message,timeoutMs=0){return new Promise((resolve,reject)=>{
 const requestId=randomUUID();let timer;
 const cleanup=()=>{clearTimeout(timer);child.off('message',got);child.off('exit',exit);child.off('error',failed);};
 const got=m=>{if(m.requestId!==requestId)return;cleanup();if(m.kind==='error'){const e=Error(m.message);e.signature=m.signature;reject(e);}else resolve(m);};
 const exit=()=>{cleanup();reject(Error('Agent exited'));};const failed=e=>{cleanup();reject(e);};
 child.on('message',got);child.once('exit',exit);child.once('error',failed);
 if(timeoutMs)timer=setTimeout(()=>{cleanup();reject(Error('Counterparty approval timed out'));},timeoutMs);
 try {child.send({...message,requestId});}catch(error){failed(error);}
});}
