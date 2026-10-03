import '../ledger.js';
const L=globalThis.DotyLedger;
const fail=(message,status=400)=>{const e=Error(message);e.status=status;throw e;};
const exact=(x,fields)=>{if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!fields.includes(k)))fail('Invalid People fields.');};
export async function directoryRequest(storage,request){
 const read=async tx=>({version:1,revision:await tx.get('people-revision')||0,people:[...(await tx.list()).entries()].filter(([k])=>k.startsWith('person:')).map(([,v])=>v).sort((a,b)=>a.name.localeCompare(b.name)),rows:[],proposals:[],audit:[...(await tx.list()).entries()].filter(([k])=>k.startsWith('people-audit:')).map(([,v])=>v)});
 if(request.method==='GET')return storage.transaction(read);
 const raw=await request.text();if(raw.length>1000000)fail('People request too large.',413);const body=JSON.parse(raw);exact(body,['actor','mutation']);const m=body.mutation;const editing=['personAdd','personEdit'].includes(m?.action);exact(m,['action','personId','operationId','previousRevision',...(editing?['name','wageDay','wageHour','wageCurrency','wageEffectiveDate']:[])]);
 if(!['personAdd','personEdit','personArchive','personRestore'].includes(m.action)||!Number.isSafeInteger(m.previousRevision)||m.previousRevision<0||!/^[A-Za-z0-9_-]{8,128}$/.test(m.operationId||''))fail('Invalid People operation.');
 if(m.action==='personAdd'&&m.personId!==undefined)fail('Person ID is not allowed when adding.');
 if(editing&&['wageDay','wageHour','wageEffectiveDate'].some(k=>m[k]!==undefined)&&m.wageCurrency===undefined)m.wageCurrency='CAD';
 if(editing&&m.wageCurrency&&m.wageCurrency!=='CAD')fail('New wage schedules use CAD only.');
 const name=editing?L.phaseName(m.name):null,wages=editing?L.personWages(m):{};
 const fingerprint=JSON.stringify([m.action,m.personId||null,name,m.previousRevision,body.actor,...(Object.keys(wages).length?[wages]:[])]);

 return storage.transaction(async tx=>{
  const old=await tx.get('people-operation:'+m.operationId);if(old){if(old.fingerprint!==fingerprint)fail('Operation ID already used for different People edit.',409);return {result:old.result,ledger:await read(tx),replayed:true};}
  const d=await read(tx);if(d.revision!==m.previousRevision)fail('People revision conflict. Refresh and review.',409);
  if(editing&&d.people.some(p=>L.phaseKey(p.name)===L.phaseKey(name)&&p.id!==m.personId))fail('A person with this name already exists (case/spacing ignored).');
  const prior=m.action!=='personAdd'?d.people.find(p=>p.id===m.personId):null;if(m.action!=='personAdd'&&!prior)fail('Person not found.',404);
  if(m.action==='personAdd'&&d.people.length>=500)fail('Maximum 500 people per account.');
  const at=new Date().toISOString(),person={...(prior||{}),id:prior?.id||crypto.randomUUID(),...(editing?{name}:{archived:m.action==='personArchive'}),editedAt:at,editedBy:body.actor};if(Object.keys(wages).length){const history=person.wageHistory||[],previous=history.filter(w=>w.currency===wages.wageCurrency&&w.effectiveDate===wages.wageEffectiveDate).sort((a,b)=>b.revision-a.revision)[0];const day=wages.wageDay??'',hour=wages.wageHour??'';if(!previous||previous.day!==day||previous.hour!==hour)person.wageHistory=history.concat({id:crypto.randomUUID(),effectiveDate:wages.wageEffectiveDate,currency:wages.wageCurrency,day,hour,revision:d.revision+1,recordedAt:at,recordedBy:body.actor,...(previous?{supersedes:previous.id}:{})});};await tx.put('person:'+person.id,person);const revision=d.revision+1;await tx.put('people-revision',revision);
  const result={revision,personId:person.id};await tx.put('people-audit:'+revision,{id:m.operationId,revision,action:m.action,personId:person.id,oldName:prior?.name||null,name:person.name,priorPerson:prior||null,person,at,actor:body.actor});await tx.put('people-operation:'+m.operationId,{fingerprint,result});return {result,ledger:await read(tx)};
 });
}
export async function peopleAccess(ctx,mutation=null){
 if(ctx.env.ENABLE_FINANCE_REVIEW!=='true')fail('Finance feature unavailable.',503);
 if(!['admin','manager'].includes(ctx.role))fail('Private People directory requires owner admin/manager role.',403);
 const ns=ctx.env.FINANCE_ACCOUNTS;if(!ns?.get)fail('Transactional finance binding required.',503);
 const stub=ns.get(ns.idFromName(JSON.stringify({kind:'people',owner:ctx.username})));
 const req=new Request('https://finance.internal/directory',mutation?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actor:ctx.username,mutation})}:{});
 const res=await stub.fetch(req),value=await res.json();if(!res.ok)fail(value.error,res.status);return value;
}
