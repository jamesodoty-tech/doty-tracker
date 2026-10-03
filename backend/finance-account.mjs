import {ownerAccountRequest} from './owner-account.mjs';
import '../ledger.js';
import {backupStoreRequest,registerBackupProject} from './backup-account.mjs';
import {contactsRequest,contactsAccess,CONTACT_TOOLS,callContactTool} from './contacts.mjs';
export {contactsAccess} from './contacts.mjs';
import {directoryRequest,peopleAccess} from './people.mjs';
export {peopleAccess} from './people.mjs';
const L = globalThis.DotyLedger;
const ROW_FIELDS = ['kind','date','phase','phaseId','currency','vendor','category','amount','tax','receipt','person','personId','sourcePersonId','wageScheduleId','unit','quantity','billRate','payRate','description','clientCharge','purchasedBy','markupRate','markupBase','billingVersion','clientTaxMode','clientTaxAmount','recordType','correctionOf','provenance'];
const METRICS = ['expenses','chargeableExpenses','billable','clientPayments','workerPay','workerPayouts'];
export class FinanceError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
function text(value,name,max=2000,required=false){
  if(value==null&&!required)return '';
  if(typeof value!=='string'||value.length>max||(required&&!value.trim()))throw new FinanceError(`${name} must be ${required?'non-empty ':''}text, maximum ${max} characters.`);
  return value;
}
function object(value,name){if(!value||typeof value!=='object'||Array.isArray(value))throw new FinanceError(`${name} must be an object.`);}
function keys(value,allowed,name){object(value,name);if(Object.keys(value).some(k=>!allowed.includes(k)))throw new FinanceError(`Unknown ${name} field. Remove IDs, void flags, sharing and audit fields from input.`);}
export function normalizeRow(input){
  keys(input,ROW_FIELDS,'row');
  const row={currency:input.currency||'CAD'};
  for(const k of ROW_FIELDS.filter(k=>k!=='provenance'))if(input[k]!=null)row[k]=text(input[k],k,k==='description'?20000:2000);
  keys(input.provenance,['reference','text','sourceId','occurrence'],'provenance');
  row.provenance={...(input.provenance.sourceId?{sourceId:text(input.provenance.sourceId,'sourceId',2000,true)}:{}),...(input.provenance.occurrence?{occurrence:text(input.provenance.occurrence,'occurrence',2000,true)}:{}),reference:text(input.provenance.reference,'source reference',2000,true),text:text(input.provenance.text,'source text',20000,true)};
  if(row.recordType&&!['transaction','evidence','correction'].includes(row.recordType))throw new FinanceError('Invalid recordType.');
  if(L.isSnapshot(row))row.recordType='evidence';
  else row.recordType=row.recordType||(row.correctionOf?'correction':'transaction');
  try{L.validate(row.kind==='expense'&&row.clientCharge==='markup'&&(row.markupRate===undefined||row.markupBase===undefined)?{...row,clientCharge:'atCost',billingVersion:undefined}:row);}catch(e){throw new FinanceError(e.message);}
  return row;
}
function checkpoint(input){
  keys(input,['currency','metric','amount','reference','throughDate','phase','phaseId'],'checkpoint');
  if(!METRICS.includes(input.metric)||!/^[A-Z]{3}$/.test(input.currency))throw new FinanceError('Invalid checkpoint metric or currency.');
  L.cents(input.amount);text(input.amount,'checkpoint amount',30,true);
  const c={...input,reference:text(input.reference,'checkpoint source',2000,true)};
  if(c.throughDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(c.throughDate)||new Date(c.throughDate+'T00:00:00Z').toISOString().slice(0,10)!==c.throughDate))throw new FinanceError('Invalid checkpoint date.');
  if(c.phase)text(c.phase,'checkpoint phase',2000,true);
  return c;
}
function strictMutation(input){
  const fields={add:['rows'],stage:['rows','checkpoints'],accept:['proposalId','confirmed','phaseId','personId','historicalPerson'],reject:['proposalId','reason'],void:['rowId','reason'],replace:['rowId','reason','rows'],unvoid:['rowId','reason'],phaseAdd:['name'],phaseRename:['phaseId','name'],phaseAssign:['rowId','phaseId'],personAssign:['rowId','personId'],currencySet:['currency'],expenseDefaultsSet:['markupRate','markupBase','clientTaxMode']};
  object(input,'mutation');
  keys(input,['operationId','previousRevision','action',...(fields[input.action]||[])],'mutation');
  if(typeof input.operationId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId))throw new FinanceError('Stable operationId required (8–128 letters, digits, _ or -).');
  if(!Number.isSafeInteger(input.previousRevision)||input.previousRevision<0)throw new FinanceError('Non-negative previousRevision required.');
  if(!['add','stage','accept','reject','void','replace','unvoid','phaseAdd','phaseRename','phaseAssign','personAssign','currencySet','expenseDefaultsSet'].includes(input.action))throw new FinanceError('Unknown financial action.');
  if(['add','stage','replace'].includes(input.action)){
    if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>100)throw new FinanceError('1–100 rows per operation required.');
    if(input.action==='replace'&&input.rows.length!==1)throw new FinanceError('Correction requires one replacement row.');
    input={...input,rows:input.rows.map(normalizeRow)};
  }else if(input.rows!==undefined)throw new FinanceError('Rows are not allowed for this action.');
  if(input.checkpoints!==undefined){if(input.action!=='stage'||!Array.isArray(input.checkpoints)||input.checkpoints.length>100)throw new FinanceError('Checkpoints are staging evidence only (maximum 100).');input={...input,checkpoints:input.checkpoints.map(checkpoint)};}
  if(['void','replace','unvoid'].includes(input.action))text(input.rowId,'rowId',100,true);
  if(['accept','reject'].includes(input.action))text(input.proposalId,'proposalId',100,true);
  if(['void','replace','unvoid','reject'].includes(input.action))text(input.reason,'reason',2000,true);
  if(input.historicalPerson!==undefined&&typeof input.historicalPerson!=='boolean')throw new FinanceError('Historical archived-person confirmation must be boolean.');
  if(input.action==='accept'&&input.confirmed!==true)throw new FinanceError('Human source/occurrence verification required.');
  if(['phaseAdd','phaseRename'].includes(input.action))input={...input,name:L.phaseName(input.name)};
  if(['phaseRename','phaseAssign'].includes(input.action))text(input.phaseId,'phaseId',100,true);
  if(input.action==='phaseAssign')text(input.rowId,'rowId',100,true);
  if(input.action==='personAssign'){text(input.personId,'personId',100,true);text(input.rowId,'rowId',100,true);}
  if(input.action==='currencySet'&&input.currency!=='CAD')throw new FinanceError('DOTY uses CAD only.');
  if(input.action==='expenseDefaultsSet'){input={...input,...L.expenseDefaults(input)};if(input.markupBase!=='net')throw new FinanceError('Project markup defaults apply before tax.');}
  return input;
}
function canonical(x){if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';return JSON.stringify(x);}
async function digest(x){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(x))))).map(v=>v.toString(16).padStart(2,'0')).join('');}
async function readLedger(storage){
  const all=await storage.list();
  const ledger={version:1,revision:all.get('revision')||0,rows:[],proposals:[],checkpoints:[],audit:[],proposalHistory:[],phases:[],phaseSchemaVersion:all.get('phase-schema')||0,expenseDefaults:all.get('expense-defaults')||null,currency:all.get('account-currency')||null};
  for(const [key,value]of all){if(key.startsWith('phase:'))ledger.phases.push(value);else if(key.startsWith('row:'))ledger.rows.push(value);else if(key.startsWith('proposal:'))ledger.proposals.push(value);else if(key.startsWith('checkpoint:'))ledger.checkpoints.push(value);else if(key.startsWith('audit:'))ledger.audit.push(value);else if(key.startsWith('proposal-history:'))ledger.proposalHistory.push(value);}
  if(L.upgradePhases(ledger,()=>crypto.randomUUID())){
    for(const phase of ledger.phases)await storage.put('phase:'+phase.id,phase);
    for(const r of ledger.rows)await storage.put('row:'+r.id,r);
    for(const q of ledger.proposals)await storage.put('proposal:'+q.id,q);
    for(const q of ledger.proposalHistory)await storage.put('proposal-history:'+q.id,q);
    for(const c of ledger.checkpoints)await storage.put('checkpoint:'+c.id,c);
    await storage.put('phase-schema',1);
    if(ledger.rows.length||ledger.proposals.length||ledger.checkpoints.length){
      ledger.revision++;const audit={id:'phase-schema-upgrade-v1',revision:ledger.revision,actor:'system',action:'phaseSchemaUpgrade',at:new Date().toISOString(),note:'Explicit legacy phase labels mapped to stable IDs; source labels/amounts preserved. Missing labels remain unassigned.'};
      await storage.put('revision',ledger.revision);await storage.put('audit:'+String(ledger.revision).padStart(12,'0'),audit);ledger.audit.push(audit);
    }
  }
  ledger.phases.sort((a,b)=>a.name.localeCompare(b.name));
  ledger.rows.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  ledger.audit.sort((a,b)=>a.revision-b.revision);
  ledger.totals=L.totals(ledger.rows);
  return ledger;
}
function reply(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});}
/* A namespace instance per [owner, projectId]. Only the authenticated Worker
   calls the stub. All revision checks, records, receipts and audit writes commit
   in one storage transaction; no finance payload is ever persisted to DOTY_KV. */
export class FinanceAccount {
  constructor(ctx,env){this.storage=ctx.storage;this.env=env;}
  async fetch(request){
    try{
      const url=new URL(request.url);
      if(url.pathname.startsWith('/owner-'))return reply(await ownerAccountRequest(this.storage,request,this.env));
      if(['/backup-snapshot','/backup-index'].includes(url.pathname))return reply(await backupStoreRequest(this.storage,request));
      if(url.pathname==='/contacts'&&['GET','POST'].includes(request.method))return reply(await contactsRequest(this.storage,request));
      if(url.pathname==='/directory'&&['GET','POST'].includes(request.method))return reply(await directoryRequest(this.storage,request));
      if(request.method==='GET'&&url.pathname==='/review')return reply(await this.storage.transaction(tx=>readLedger(tx)));
      if(request.method!=='POST'||url.pathname!=='/mutate')return reply({error:'Not found'},404);
      if(Number(request.headers.get('content-length'))>1000000)throw new FinanceError('Payload too large.',413);
      const raw=await request.text();if(raw.length>1000000)throw new FinanceError('Payload too large.',413);
      const body=JSON.parse(raw);keys(body,['actor','channel','mutation','directory','expenseDefaults'],'request');
      const actor=text(body.actor,'actor',100,true);
      if(!['browser','mcp'].includes(body.channel))throw new FinanceError('Invalid channel.');
      let mutation=strictMutation(body.mutation);
      if(mutation.action==='stage'){
        const normalized=[];
        for(const row of mutation.rows){
          if(!row.provenance.sourceId)row.provenance.sourceId='note:'+await digest([row.provenance.reference,row.provenance.text,row.kind,row.provenance.occurrence||'']);
          normalized.push(row);
        }
        mutation={...mutation,rows:normalized};
      }
      if(body.channel==='mcp'&&['accept','unvoid'].includes(mutation.action))throw new FinanceError('Import acceptance and unvoid require the browser review UI.',403);
      const fingerprint=await digest({actor,channel:body.channel,mutation});
      const checkpointIds=await Promise.all((mutation.checkpoints||[]).map(digest));
      const result=await this.storage.transaction(async tx=>{
        const receipt=await tx.get('operation:'+mutation.operationId);
        if(receipt){if(receipt.fingerprint!==fingerprint)throw new FinanceError('operationId was already used with a different payload.',409);return {replayed:true,result:receipt.result,ledger:await readLedger(tx)};}
        const ledger=await readLedger(tx);
        if(ledger.revision!==mutation.previousRevision)throw new FinanceError(`Finance revision conflict: expected ${mutation.previousRevision}, current ${ledger.revision}. Reload and review.`,409);
        if(ledger.rows.length+ledger.proposals.length>10000)throw new FinanceError('Account exceeds review limit; archive/export plan required.',413);
        const now=new Date().toISOString();const rowIds=[];const proposalIds=[];const warnings=[];const phaseIds=[];
        ledger.people=body.directory?.people||[];ledger.expenseDefaults=ledger.expenseDefaults||L.expenseDefaults(body.expenseDefaults||{});
        const person=(row,staged=false,allowArchived=false)=>{try{return L.resolvePerson(ledger,row,staged,allowArchived);}catch(e){throw new FinanceError(e.message);}};
        const phase=(row,staged=false)=>{try{return L.resolvePhase(ledger,row,staged);}catch(e){throw new FinanceError(e.message);}};
        const newRow=(r)=>{const id=crypto.randomUUID();return {...r,id,provenance:{...r.provenance,sourceId:r.provenance.sourceId||'ledger:'+id},createdAt:now,createdBy:actor,channel:body.channel,operationId:mutation.operationId};};
        const snapshotSource=L.isSnapshot;
        const verifyOccurrence=r=>{if(r.provenance.sourceId&&ledger.rows.some(x=>x.provenance.sourceId===r.provenance.sourceId&&(mutation.action!=='replace'||x.id!==mutation.rowId)&&(!r.correctionOf||x.id!==r.correctionOf)))throw new FinanceError('Source occurrence already accepted. Use an explicit correction, not another import.',409);};
        const applyCorrection=async(r)=>{if(!r.correctionOf)return;const old=ledger.rows.find(x=>x.id===r.correctionOf);if(!old)throw new FinanceError('Correction target not found.',404);if(old.voided)throw new FinanceError('Correction target already voided.',409);old.voided=true;old.voidedAt=now;old.voidedBy=actor;old.voidReason='Replaced by sourced correction';await tx.put('row:'+old.id,old);};
        const row=()=>{const r=ledger.rows.find(r=>r.id===mutation.rowId);if(!r)throw new FinanceError('Row not found.',404);return r;};
        if(mutation.action==='accept'&&ledger.proposals.find(q=>q.id===mutation.proposalId)?.row.currency!=='CAD')throw new FinanceError('Unsupported non-CAD proposal; preserve source evidence without accepting it as CAD.');
        if(['add','replace'].includes(mutation.action)&&mutation.rows.some(r=>r.currency!=='CAD'))throw new FinanceError('New financial records use CAD only. Unsupported source currency must remain staged evidence.');
        if(mutation.action==='expenseDefaultsSet'){await tx.put('expense-defaults',L.expenseDefaults(mutation));
        }else if(mutation.action==='currencySet'){await tx.put('account-currency',mutation.currency);
        }else if(mutation.action==='personAssign'){const r=row();if(!['labour','workerPayout'].includes(r.kind)||ledger.people.some(person=>person.id===r.personId))throw new FinanceError('Only unassigned legacy labour/payout rows can be assigned.');const personId=person({...r,personId:mutation.personId},false,true);await tx.put('row:'+r.id,{...r,...(r.personId?{sourcePersonId:r.personId}:{}),personId,personAssignedAt:now,personAssignedBy:actor});rowIds.push(r.id);
        }else if(['phaseAdd','phaseRename'].includes(mutation.action)){
          const existing=ledger.phases.find(p=>L.phaseKey(p.name)===L.phaseKey(mutation.name));
          if(existing&&existing.id!==mutation.phaseId)throw new FinanceError('A phase with this name already exists (case/spacing ignored).',400);
          if(mutation.action==='phaseAdd'){
            if(ledger.phases.length>=100)throw new FinanceError('Maximum 100 phases per project.');
            const record={id:crypto.randomUUID(),name:mutation.name,createdAt:now,createdBy:actor};await tx.put('phase:'+record.id,record);phaseIds.push(record.id);
          }else{
            const record=ledger.phases.find(p=>p.id===mutation.phaseId);if(!record)throw new FinanceError('Phase not found.',404);
            await tx.put('phase:'+record.id,{...record,name:mutation.name,renamedAt:now,renamedBy:actor});phaseIds.push(record.id);
          }
        }else if(mutation.action==='phaseAssign'){
          const r=row();const phaseId=phase({phaseId:mutation.phaseId});
          if(r.phaseId&&ledger.phases.some(p=>p.id===r.phaseId))throw new FinanceError('Existing assigned rows use a sourced correction to change phase.');
          await tx.put('row:'+r.id,{...r,phaseId,phaseAssignedAt:now,phaseAssignedBy:actor});rowIds.push(r.id);phaseIds.push(phaseId);
        }else if(['add','stage','replace'].includes(mutation.action)){
          if(mutation.action==='replace'){const old=row();if(old.voided)throw new FinanceError('Cannot replace an already voided row.',409);old.voided=true;old.voidedAt=now;old.voidedBy=actor;old.voidReason=mutation.reason;await tx.put('row:'+old.id,old);}
          for(const inputRow of mutation.rows){
            let r=inputRow;if(r.kind==='expense'&&r.clientCharge==='markup'&&mutation.action==='add')r={...r,billingVersion:'2',markupRate:r.markupRate??ledger.expenseDefaults.markupRate,markupBase:r.markupBase??ledger.expenseDefaults.markupBase,clientTaxMode:r.clientTaxMode??ledger.expenseDefaults.clientTaxMode};L.validate(r);
            const phaseId=phase(r,mutation.action==='stage');
            const personId=person(r,mutation.action==='stage',mutation.action==='replace'&&ledger.rows.find(x=>x.id===mutation.rowId)?.personId===r.personId);
            if(mutation.action==='add'&&r.kind==='labour'&&r.currency!=='CAD')throw new FinanceError('New labour uses CAD.');
            let rateFields={};if(mutation.action==='add'&&r.kind==='labour'&&r.payRate===undefined){const rate=L.wageFor(ledger.people.find(p=>p.id===personId),r.unit,r.currency,r.date);rateFields={payRate:rate.value,...(rate.value!==''?{wageScheduleId:rate.scheduleId}:{} )};}
            if(mutation.action==='add'&&r.wageScheduleId){const schedule=ledger.people.find(p=>p.id===personId)?.wageHistory?.find(w=>w.id===r.wageScheduleId);if(!schedule||schedule.currency!==r.currency||!L.validDate(r.date)||schedule.effectiveDate>r.date||(r.unit==='days'?schedule.day:schedule.hour)!==r.payRate)throw new FinanceError('Wage schedule snapshot does not match the recorded date, currency, unit and pay rate.');}
            const assigned={...r,...rateFields,...(r.personId&&r.personId!==personId?{sourcePersonId:r.personId}:{}),person:r.person||ledger.people.find(p=>p.id===personId)?.name,phaseId,...(['labour','workerPayout'].includes(r.kind)?{personId}:{}),...(r.phaseId&&r.phaseId!==phaseId?{sourcePhaseId:r.phaseId}:{})};
            if(!phaseId)warnings.push('Unassigned legacy proposal: select a project phase before accepting.');
            const ws=L.warnings(r,ledger.rows.concat(ledger.proposals.map(p=>p.row)));warnings.push(...ws);
            // A narrative identified as a running snapshot must be staged as
            // evidence first. No conversational direct-add creates a total row.
            if(mutation.action!=='stage'&&snapshotSource(r))throw new FinanceError('Running totals must be staged for review, not logged as transactions.');
            if(mutation.action!=='stage'){
              if(/correct|replace|amend|instead/i.test(r.provenance.text)&&!r.correctionOf&&mutation.action!=='replace')throw new FinanceError('Correction needs an exact target row ID. Stage for review or use correction action.');
              if(mutation.action==='replace'&&r.correctionOf&&r.correctionOf!==mutation.rowId)throw new FinanceError('Conflicting correction targets.');
              if(mutation.action!=='replace')await applyCorrection(r);
              verifyOccurrence(r);
            }
            const record=newRow(L.expenseSnapshot(assigned));
            if(mutation.action==='stage'){const q={id:crypto.randomUUID(),row:record,warnings:ws,createdAt:now,createdBy:actor};await tx.put('proposal:'+q.id,q);ledger.proposals.push(q);proposalIds.push(q.id);}
            else {if(mutation.action==='replace')record.replaces=mutation.rowId;await tx.put('row:'+record.id,record);ledger.rows.push(record);rowIds.push(record.id);}
          }
          for(const [index,c]of (mutation.checkpoints||[]).entries()){const id=checkpointIds[index];const phaseId=c.phaseId||c.phase?phase(c,true):null;if((c.phaseId||c.phase)&&!phaseId)throw new FinanceError('Checkpoint phase must reference this project.');if(!await tx.get('checkpoint:'+id))await tx.put('checkpoint:'+id,{...c,phaseId,id,createdAt:now,createdBy:actor});}
        }else if(['accept','reject'].includes(mutation.action)){
          const q=ledger.proposals.find(q=>q.id===mutation.proposalId);if(!q)throw new FinanceError('Proposal not found.',404);
          if(mutation.action==='accept'){
            if(snapshotSource(q.row))throw new FinanceError('Running totals are evidence only. Discard this proposal and add a checkpoint.');
            if(/correct|replace|amend|instead/i.test(q.row.provenance.text)&&!q.row.correctionOf)throw new FinanceError('Correction needs an exact target row ID before acceptance.');
            const phaseId=phase({phaseId:mutation.phaseId||q.row.phaseId});
            await applyCorrection(q.row);verifyOccurrence(q.row);
            const personId=person({...q.row,personId:mutation.personId||q.row.personId},false,mutation.historicalPerson===true);
            const r={...q.row,person:q.row.person||ledger.people.find(p=>p.id===personId)?.name,phaseId,...(['labour','workerPayout'].includes(q.row.kind)?{personId}:{}),reviewedAt:now,reviewedBy:actor,proposalId:q.id};await tx.put('row:'+r.id,r);ledger.rows.push(r);rowIds.push(r.id);}
          // Proposal provenance is retained in the immutable audit, even on reject.
          await tx.delete('proposal:'+q.id);
          await tx.put('proposal-history:'+q.id,{...q,resolution:mutation.action,resolvedAt:now,resolvedBy:actor,reason:mutation.reason||'Verified source and occurrence'});
        }else{
          const r=row();const unvoid=mutation.action==='unvoid';
          if(unvoid&&!r.voided||!unvoid&&r.voided)throw new FinanceError('Row already has the requested void status.',409);
          if(unvoid){if(ledger.rows.some(x=>!x.voided&&x.id!==r.id&&x.provenance.sourceId===r.provenance.sourceId))throw new FinanceError('Source occurrence already active.',409);if(ledger.rows.some(x=>!x.voided&&(x.replaces===r.id||x.correctionOf===r.id)))throw new FinanceError('Active replacement exists; void it before restoring the original.',409);}
          r.voided=!unvoid;r.voidedAt=now;r.voidedBy=actor;r.voidReason=mutation.reason;
          await tx.put('row:'+r.id,r);rowIds.push(r.id);
        }
        L.totals(ledger.rows); // overflow and validation failures roll back everything
        const revision=ledger.revision+1;
        const result={revision,action:mutation.action,rowIds,proposalIds,phaseIds,warnings};
        const audit={id:mutation.operationId,revision,actor,channel:body.channel,action:mutation.action,rowIds,proposalIds,phaseIds,phaseName:mutation.name||null,sourceRow:mutation.rowId||null,sourceProposal:mutation.proposalId||null,reason:mutation.reason||null,at:now};
        await tx.put('audit:'+String(revision).padStart(12,'0'),audit);
        await tx.put('revision',revision);
        await tx.put('operation:'+mutation.operationId,{fingerprint,result});
        return {replayed:false,result,ledger:await readLedger(tx)};
      });
      return reply(result);
    }catch(e){return reply({error:e.message||'Finance request failed'},e.status||400);}
  }
}
export async function financeAccess(ctx,args,write,channel='mcp'){
  if(ctx.env.ENABLE_FINANCE_REVIEW!=='true')throw new FinanceError('Finance unavailable: feature is not enabled.',503);
  if(!['admin','manager'].includes(ctx.role))throw new FinanceError('Private finance requires owner admin/manager role.',403);
  keys(args,write?['project_id','mutation']:['project_id'],'finance arguments');
  text(args.project_id,'exact project_id',100,true);
  const raw=await ctx.env.DOTY_KV.get('data:'+ctx.username);
  const rec=raw?JSON.parse(raw):null;
  if(!(rec?.data?.projects||[]).some(p=>p.id===args.project_id&&!p.sharedVirtual))throw new FinanceError('Owned project not found.',404);
  if(write&&(rec?.data?.projects||[]).find(p=>p.id===args.project_id)?.archived)throw new FinanceError('Restore the archived project before recording financial changes.');
  const namespace=ctx.env.FINANCE_ACCOUNTS;
  if(!namespace?.idFromName||!namespace?.get)throw new FinanceError('FINANCE_ACCOUNTS transactional binding required.',503);
  const stub=namespace.get(namespace.idFromName(JSON.stringify([ctx.username,args.project_id])));
  await registerBackupProject(ctx,args.project_id);
  const directory=await peopleAccess(ctx);
  const request=write?new Request('https://finance.internal/mutate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({actor:ctx.username,channel,mutation:args.mutation,directory:{people:directory.people},expenseDefaults:(rec.data.projects.find(p=>p.id===args.project_id)?.createdVersion==='8.0'?{markupRate:'15.00',markupBase:'net',clientTaxMode:'hst13'}:{markupRate:'0.00',markupBase:'net',clientTaxMode:'hst13'})})}):new Request('https://finance.internal/review');
  const response=await stub.fetch(request);const body=await response.json();
  if(!response.ok)throw new FinanceError(body.error||'Finance store failed',response.status);
  const ledger=body.ledger||body;ledger.expenseDefaults=ledger.expenseDefaults||L.expenseDefaults(rec.data.projects.find(p=>p.id===args.project_id)?.createdVersion==='8.0'?{markupRate:'15.00',markupBase:'net',clientTaxMode:'hst13'}:{});ledger.people=directory.people;ledger.peopleRevision=directory.revision;ledger.currency=L.accountCurrency(ledger);return body;
}
const rowSchema={type:'object',additionalProperties:false,properties:Object.fromEntries(ROW_FIELDS.map(k=>[k,k==='currency'?{type:'string'}:k==='kind'?{type:'string',enum:['expense','labour','clientPayment','workerPayout']}:k==='provenance'?{type:'object',additionalProperties:false,properties:{reference:{type:'string'},text:{type:'string'},sourceId:{type:'string'},occurrence:{type:'string'}},required:['reference','text']}:{type:'string'}])),required:['kind','provenance']};
const cadRowSchema={...rowSchema,properties:Object.fromEntries(Object.entries(rowSchema.properties).filter(([key])=>key!=='currency'))};
export const FINANCE_TOOLS=[
 ...CONTACT_TOOLS,
 {name:'get_person_wage',description:'Read private known wage default by work date and days/hours (CAD). Missing history stays unknown. No conversion; archived people require historical review or restore for bookings.',inputSchema:{type:'object',additionalProperties:false,properties:{person_id:{type:'string'},work_date:{type:'string'},unit:{type:'string',enum:['days','hours']}},required:['person_id','work_date','unit']}},
 ...['list_account_people','add_account_person','edit_account_person','archive_account_person','restore_account_person'].map(name=>{const list=name==='list_account_people',edit=['add_account_person','edit_account_person'].includes(name),id=name!=='add_account_person'&&!list;return {name,description:'Private owner account People and wage defaults. Stable IDs across projects; no login or client billing changes. Wage defaults are snapshots for new drafts only. Archive hides new bookings; records remain. Read revision and reuse operation IDs.',inputSchema:{type:'object',additionalProperties:false,properties:list?{}:{operation_id:{type:'string'},previous_revision:{type:'integer'},...(edit?{name:{type:'string'},wageDay:{type:'string'},wageHour:{type:'string'},wageEffectiveDate:{type:'string'}}:{}),...(id?{person_id:{type:'string'}}:{})},required:list?[]:['operation_id','previous_revision',...(edit?['name']:[]),...(id?['person_id']:[])]}};}),
 {name:'set_expense_defaults',description:'Set this project default expense markup for NEW entries only. 15% markup is not a 15% profit margin. Markup uses the known purchase subtotal before tax. Explicit client tax treatment applies to the marked-up subtotal; historic entries remain unchanged.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'},operation_id:{type:'string'},previous_revision:{type:'integer'},markupRate:{type:'string'},markupBase:{type:'string',enum:['net']},clientTaxMode:{type:'string',enum:['hst13','none','manual']}},required:['project_id','operation_id','previous_revision','markupRate','markupBase','clientTaxMode']}},
 {name:'list_finance_phases',description:'Read this project’s configured phase names/IDs and current revision. Use a phaseId on new financial rows; never invent a phase.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'}},required:['project_id']}},
 {name:'add_finance_phase',description:'Add a project phase with a normalized unique name. Read revision first and reuse operation_id on retries. Case/whitespace duplicate names reject.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'},operation_id:{type:'string'},previous_revision:{type:'integer'},name:{type:'string'}},required:['project_id','operation_id','previous_revision','name']}},
 {name:'rename_finance_phase',description:'Rename a configured phase by stable ID; existing rows/proposals/checkpoints keep their grouping and original source labels. No delete/archive.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'},operation_id:{type:'string'},previous_revision:{type:'integer'},phase_id:{type:'string'},name:{type:'string'}},required:['project_id','operation_id','previous_revision','phase_id','name']}},
 {name:'get_finance_review',description:'Read your private exact-project financial ledger, pending proposals, revision and currency totals. Account balance is not an issued invoice. Worker pay is private.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'}},required:['project_id']}},
 {name:'record_finance_rows',description:'Record explicit expense, labour, client receipt or worker payout transactions. Read revision first and list_account_people for stable personId on labour/payouts. New records use CAD, with currency omitted. Use stable operation_id across retries. Provide source reference/text; never infer rates, dates, tax, gaps or duplicate days. Narrative totals must be staged. No human import approval.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'},operation_id:{type:'string'},previous_revision:{type:'integer'},rows:{type:'array',minItems:1,maxItems:100,items:{...cadRowSchema,required:[...cadRowSchema.required,'phaseId']}}},required:['project_id','operation_id','previous_revision','rows']}},
 {name:'stage_finance_rows',description:'Stage note-backed proposals with provenance for human browser review. Does not create accepted transactions. Repeated undated days may be distinct occurrences. Running totals belong in checkpoints.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'},operation_id:{type:'string'},previous_revision:{type:'integer'},rows:{type:'array',minItems:1,maxItems:100,items:rowSchema},checkpoints:{type:'array',items:{type:'object'}}},required:['project_id','operation_id','previous_revision','rows']}},
 {name:'correct_finance_row',description:'Atomically void a specific accepted row and record one corrected replacement, preserving audit/provenance. Read revision, identify row ID, provide reason. Reuse operation_id on retry.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'},operation_id:{type:'string'},previous_revision:{type:'integer'},row_id:{type:'string'},reason:{type:'string'},row:{...cadRowSchema,required:[...cadRowSchema.required,'phaseId']}},required:['project_id','operation_id','previous_revision','row_id','reason','row']}},
 {name:'void_finance_row',description:'Void a specific incorrect transaction with reason; retain history. Never delete source notes. Human browser review can unvoid.',inputSchema:{type:'object',additionalProperties:false,properties:{project_id:{type:'string'},operation_id:{type:'string'},previous_revision:{type:'integer'},row_id:{type:'string'},reason:{type:'string'}},required:['project_id','operation_id','previous_revision','row_id','reason']}}
];
export async function callFinanceTool(name,args,ctx){
 const def=FINANCE_TOOLS.find(d=>d.name===name);if(!def)throw new FinanceError('Unknown finance tool.');keys(args,Object.keys(def.inputSchema.properties),'tool arguments');
 for(const field of def.inputSchema.required)if(args[field]===undefined)throw new FinanceError('Missing '+field);
 if(CONTACT_TOOLS.some(t=>t.name===name))return callContactTool(name,args,ctx);
 if(name==='get_person_wage'){if(!L.validDate(args.work_date)||!['days','hours'].includes(args.unit)||(args.currency&&args.currency!=='CAD'))throw new FinanceError('Valid date/unit/currency required.');const d=await peopleAccess(ctx),person=d.people.find(p=>p.id===args.person_id);if(!person)throw new FinanceError('Person not found.',404);return {...L.wageFor(person,args.unit,'CAD',args.work_date),archived:!!person.archived,personId:person.id};}
 if(name==='list_account_people')return peopleAccess(ctx);
 if(['add_account_person','edit_account_person','archive_account_person','restore_account_person'].includes(name))return peopleAccess(ctx,{action:{add_account_person:'personAdd',edit_account_person:'personEdit',archive_account_person:'personArchive',restore_account_person:'personRestore'}[name],operationId:args.operation_id,previousRevision:args.previous_revision,...(args.name!==undefined?{name:args.name}:{}),...L.personWages({...args,...(['wageDay','wageHour','wageEffectiveDate'].some(k=>args[k]!==undefined)?{wageCurrency:'CAD'}:{})}),...(args.person_id?{personId:args.person_id}:{})});
 if(name==='list_finance_phases'){const data=await financeAccess(ctx,args,false);return {revision:data.revision,phases:data.phases};}
 if(name==='get_finance_review')return financeAccess(ctx,args,false);
 const action={record_finance_rows:'add',stage_finance_rows:'stage',correct_finance_row:'replace',void_finance_row:'void',add_finance_phase:'phaseAdd',rename_finance_phase:'phaseRename',set_expense_defaults:'expenseDefaultsSet'}[name];
 const mutation={operationId:args.operation_id,previousRevision:args.previous_revision,action,...(action==='expenseDefaultsSet'?L.expenseDefaults(args):{})};
 if(args.name)mutation.name=args.name;if(args.phase_id)mutation.phaseId=args.phase_id;
 if(args.rows)mutation.rows=args.rows;if(args.row)mutation.rows=[args.row];if(args.row_id)mutation.rowId=args.row_id;if(args.reason)mutation.reason=args.reason;if(args.checkpoints)mutation.checkpoints=args.checkpoints;
 return financeAccess(ctx,{project_id:args.project_id,mutation},true,'mcp');
}
