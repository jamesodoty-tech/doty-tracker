/* Test/local-preview adapter only. Production uses Cloudflare Durable Object
   storage. Clone per transaction, serialize commits, roll back on any failure. */
import fs from 'node:fs/promises';
export class LocalTransactionStorage {
 constructor(file=null){this.file=file;this.map=new Map();this.queue=Promise.resolve();this.ready=this.initialize();}
 async initialize(){if(this.file){try{this.map=new Map(JSON.parse(await fs.readFile(this.file,'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}}}
 transaction(fn){
  const promise=this.queue.catch(()=>{}).then(async()=>{
   await this.ready;const next=structuredClone(this.map);
   const tx={get:async key=>structuredClone(next.get(key)),put:async(key,value)=>{next.set(key,structuredClone(value));},delete:async key=>next.delete(key),list:async()=>structuredClone(next)};
   const result=await fn(tx);
   if(this.file){await fs.mkdir(new URL('.', 'file://'+this.file).pathname,{recursive:true});await fs.writeFile(this.file+'.tmp',JSON.stringify([...next]));await fs.rename(this.file+'.tmp',this.file);}
   this.map=next;return result;
  });
  this.queue=promise;return promise;
 }
}
export function localNamespace(FinanceAccount,options={}){
 const instances=new Map();return {instances,idFromName:name=>name,get:name=>{
  if(!instances.has(name)){const file=options.fileFor?.(name)||null;const storage=new LocalTransactionStorage(file);instances.set(name,new FinanceAccount({storage},options.env||{}));}
  return instances.get(name);
 }};
}
