/* Transport is injectable for tests. Pending intents are never rebased silently. */
(function(root){
'use strict';
class FinanceClient {
 constructor({request,storage,newId}){this.request=request;this.storage=storage;this.newId=newId;this.cache=new Map();this.loading=new Map();this.busy=new Set();}
 pendingKey(key){return 'doty.finance.pending.v1:'+key;}
 pending(key){const raw=this.storage.getItem(this.pendingKey(key));return raw?JSON.parse(raw):null;}
 async load(key,project){
  if(this.loading.has(key))return this.loading.get(key);
  const promise=this.request(project,null).then(data=>{
   if(data.version!==1||!Number.isSafeInteger(data.revision)||!Array.isArray(data.rows)||!Array.isArray(data.proposals))throw Error('Invalid financial response.');
   this.cache.set(key,data);
   const pending=this.pending(key);if(pending&&data.audit?.some(a=>a.id===pending.operationId))this.storage.removeItem(this.pendingKey(key));
   return data;
  }).finally(()=>this.loading.delete(key));
  this.loading.set(key,promise);return promise;
 }
 async mutate(key,project,previousRevision,operation){
  if(this.pending(key))throw Error('A pending financial write needs retry or review first.');
  const mutation={...operation,operationId:this.newId(),previousRevision};
  this.storage.setItem(this.pendingKey(key),JSON.stringify(mutation));
  return this.retry(key,project);
 }
 async retry(key,project){
  if(this.busy.has(key))throw Error('Financial write already in progress.');
  const mutation=this.pending(key);if(!mutation)throw Error('No pending write.');
  this.busy.add(key);
  try{
   const response=await this.request(project,mutation);
   if(!response.ledger||!response.result||!Number.isSafeInteger(response.ledger.revision))throw Error('Invalid write response; retry the same operation.');
   this.cache.set(key,response.ledger);this.storage.removeItem(this.pendingKey(key));return response;
  }catch(e){if([400,401,403,404,413,422].includes(e.status))this.storage.removeItem(this.pendingKey(key));throw e;}finally{this.busy.delete(key);}
 }
 discard(key){if(this.busy.has(key))throw Error('Wait for the write to finish.');this.storage.removeItem(this.pendingKey(key));}
}
root.DotyFinanceClient=FinanceClient;if(typeof module!=='undefined')module.exports=FinanceClient;
})(globalThis);
