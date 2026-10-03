const assert=require('node:assert/strict');
const url='http://127.0.0.1:8766/local-mcp';
async function rpc(name,args){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});const r=await response.json();if(r.error)throw Error(r.error.message);return JSON.parse(r.result.content[0].text);}
(async()=>{
 const before=await rpc('get_finance_review',{project_id:'synthetic-account'});
 const row={kind:'labour',date:'',phase:'Kitchen',currency:'USD',person:'Review worker (synthetic)',unit:'days',quantity:'0.5',billRate:'750.00',payRate:'425.00',description:'Synthetic review regression',provenance:{reference:'Synthetic note · occurrence A',text:'Half day worked',sourceId:'synthetic-ui-review-A',occurrence:'A'}};
 // A fixed operation ID makes rerunning this smoke test safe after the server persists.
 const existing=before.proposals.find(q=>q.row.provenance?.sourceId===row.provenance.sourceId);
 if(existing){console.log(JSON.stringify({revision:before.revision,proposalId:existing.id,alreadyStaged:true}));return;}
 if(before.rows.some(r=>r.provenance?.sourceId===row.provenance.sourceId)){console.log('Review occurrence already accepted/voided; inspect audit.');return;}
 const args={project_id:'synthetic-account',operation_id:'synthetic-ui-review-stage-A',previous_revision:before.revision,rows:[row]};
 const staged=await rpc('stage_finance_rows',args);const replay=await rpc('stage_finance_rows',args);
 assert.equal(replay.replayed,true);assert.equal(staged.ledger.rows.length,before.rows.length);assert.equal(staged.ledger.proposals.length,before.proposals.length+1);
 console.log(JSON.stringify({revision:staged.ledger.revision,proposalId:staged.result.proposalIds[0],replaySafe:true,acceptedRowsUnchanged:true}));
})().catch(e=>{console.error(e);process.exitCode=1});
