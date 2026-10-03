const assert=require('node:assert/strict');const L=require('./ledger.js');
(async()=>{
 const {FinanceAccount,financeAccess,callFinanceTool}=await import('./backend/finance-account.mjs');
 const {localNamespace}=await import('./backend/local-storage.mjs');
 const namespace=localNamespace(FinanceAccount);
 const env={ENABLE_FINANCE_REVIEW:'true',FINANCE_ACCOUNTS:namespace,DOTY_KV:{get:async key=>key==='data:owner'?JSON.stringify({data:{projects:[{id:'existing'},{id:'empty'}],timeEntries:[{id:'t',hours:2}],notes:'Original synthetic note'} }):null}};
 const ctx={username:'owner',role:'admin',env};let seq=0;
 const read=id=>financeAccess(ctx,{project_id:id},false);
 const mutate=async(id,action,extra={},channel='browser')=>{const data=await read(id);return financeAccess(ctx,{project_id:id,mutation:{action,previousRevision:data.revision,operationId:'phase-operation-'+(++seq),...extra}},true,channel);};
 const source={kind:'expense',date:'2026-09-01',currency:'CAD',vendor:'Demo',category:'Materials',clientCharge:'atCost',amount:'10.00',provenance:{reference:'Synthetic receipt',text:'Demo purchase'}};
 const originals=['Bathroom',' bathroom  ','Bath room','Kitchen','Kitchen 2',''].map((phase,i)=>({...source,id:'legacy-'+i,phase,currency:i===4?'USD':'CAD',createdAt:'2026-09-01T00:00:00Z',provenance:{...source.provenance,sourceId:'legacy-source-'+i},voided:i===2}));
 const account=namespace.get(namespace.idFromName(JSON.stringify(['owner','existing'])));
 await account.storage.transaction(async tx=>{await tx.put('revision',6);for(const r of originals)await tx.put('row:'+r.id,r);await tx.put('operation:old-receipt',{fingerprint:'unchanged',result:{revision:6}});});
 const migrated=await read('existing');assert.equal(migrated.revision,7);assert.equal(migrated.phaseSchemaVersion,1);assert.equal(migrated.phases.length,4);
 const row=id=>migrated.rows.find(r=>r.id===id);
 assert.equal(row('legacy-0').phaseId,row('legacy-1').phaseId);assert.notEqual(row('legacy-0').phaseId,row('legacy-2').phaseId);assert.notEqual(row('legacy-3').phaseId,row('legacy-4').phaseId);assert.equal(row('legacy-5').phaseId,null);
 for(const original of originals){const now=row(original.id);for(const k of Object.keys(original))assert.deepEqual(now[k],original[k],k);}
 assert.equal((await read('existing')).revision,7);assert.equal((await account.storage.transaction(tx=>tx.get('operation:old-receipt'))).fingerprint,'unchanged');
 const totals=JSON.stringify(migrated.totals);const kitchen=migrated.phases.find(p=>p.name==='Kitchen');
 const renamed=await callFinanceTool('rename_finance_phase',{project_id:'existing',operation_id:'rename-kitchen-source',previous_revision:7,phase_id:kitchen.id,name:'  Kitchen   finish  '},ctx);
 assert.equal(renamed.ledger.phases.find(p=>p.id===kitchen.id).name,'Kitchen finish');assert.equal(renamed.ledger.rows.find(r=>r.id==='legacy-3').phaseId,kitchen.id);assert.equal(renamed.ledger.rows.find(r=>r.id==='legacy-3').phase,'Kitchen');assert.equal(JSON.stringify(renamed.ledger.totals),totals);
 // Recreate the object against the same persisted storage, simulating reload/restart.
 const reloaded=new FinanceAccount({storage:account.storage},{});const state=await (await reloaded.fetch(new Request('https://finance.internal/review'))).json();assert.equal(state.phases.find(p=>p.id===kitchen.id).name,'Kitchen finish');
 const before=JSON.stringify(await read('existing'));await assert.rejects(mutate('existing','phaseAdd',{name:'  KITCHEN    FINISH  '}),/already exists/);assert.equal(JSON.stringify(await read('existing')),before);
 await assert.rejects(mutate('existing','phaseRename',{phaseId:kitchen.id,name:' bathroom '}),/already exists/);await assert.rejects(mutate('existing','phaseRename',{phaseId:'foreign',name:'New'}),/not found/);
 assert.equal((await read('empty')).phases.length,0);assert.equal((await read('empty')).revision,0);
 await assert.rejects(mutate('empty','add',{rows:[source]}),/Select a project phase/);
 const added=await callFinanceTool('add_finance_phase',{project_id:'empty',operation_id:'phase-add-first',previous_revision:0,name:'  Main   room  '},ctx);const firstId=added.result.phaseIds[0];assert.equal(added.ledger.phases[0].name,'Main room');
 const listed=await callFinanceTool('list_finance_phases',{project_id:'empty'},ctx);assert.equal(listed.phases[0].id,firstId);
 await assert.rejects(mutate('empty','add',{rows:[{...source,phaseId:kitchen.id}]}),/Unknown phase ID/);
 await assert.rejects(mutate('empty','phaseAdd',{name:'   '}),/1–120/);
 const staged=await mutate('empty','stage',{rows:[{...source,phase:'Typo room',phaseId:'foreign-export-id'}]});assert.equal(staged.ledger.proposals[0].row.phaseId,null);assert.equal(staged.ledger.proposals[0].row.sourcePhaseId,'foreign-export-id');assert.equal(staged.ledger.phases.length,1);
 await assert.rejects(mutate('empty','accept',{proposalId:staged.result.proposalIds[0],confirmed:true}),/Select a project phase/);
 const accepted=await mutate('empty','accept',{proposalId:staged.result.proposalIds[0],confirmed:true,phaseId:firstId});assert.equal(accepted.ledger.rows[0].phaseId,firstId);assert.equal(accepted.ledger.rows[0].phase,'Typo room');
 const matched=await mutate('empty','stage',{rows:[{...source,phase:' main  ROOM ',provenance:{...source.provenance,sourceId:'another-source'}}]});assert.equal(matched.ledger.proposals[0].row.phaseId,firstId);
 const scoped=await mutate('empty','stage',{rows:[{...source,phaseId:firstId,provenance:{...source.provenance,sourceId:'scope-source'}}],checkpoints:[{metric:'expenses',currency:'CAD',amount:'10.00',reference:'Synthetic total',phaseId:firstId}]});
 const changed=await mutate('empty','phaseRename',{phaseId:firstId,name:'Renamed room'});assert.equal(changed.ledger.checkpoints[0].phaseId,firstId);assert.equal(changed.ledger.proposals[0].row.phaseId,firstId);
 const assigned=await mutate('existing','phaseAssign',{rowId:'legacy-5',phaseId:kitchen.id});assert.equal(assigned.ledger.rows.find(r=>r.id==='legacy-5').phaseId,kitchen.id);assert.equal(JSON.stringify(assigned.ledger.totals),totals);
 // Client and backend use the same normalization, preserving punctuation/distinct names.
 assert.equal(L.phaseKey('  MAIN\tRoom  '),L.phaseKey('main room'));assert.notEqual(L.phaseKey('Main-room'),L.phaseKey('Main room'));assert.notEqual(L.phaseKey('Room 1'),L.phaseKey('Room 2'));
 console.log('PASS: stable phase migration, preserved source/amounts/void/history, no financial total change, distinct names, normalized duplicate rejection, empty/no-default project, unknown/cross-project IDs, MCP read/add/rename parity, proposal selection, checkpoint grouping, rename/reload, explicit legacy assignment.');
})().catch(e=>{console.error(e);process.exitCode=1});
