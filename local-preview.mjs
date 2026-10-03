import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {FinanceAccount,financeAccess,peopleAccess,contactsAccess,callFinanceTool,FINANCE_TOOLS} from './backend/finance-account.mjs';
import {LocalBackupService,recoverRestore} from './backend/backup-local.mjs';
import {localNamespace} from './backend/local-storage.mjs';
const root=path.dirname(new URL(import.meta.url).pathname);
let port=Number(process.env.DOTY_PREVIEW_PORT||8766);
const dataRoot=process.env.DOTY_PREVIEW_DATA_ROOT||root;
await recoverRestore(dataRoot);
const namespace=localNamespace(FinanceAccount,{fileFor:name=>path.join(dataRoot,'.preview',Buffer.from(name).toString('base64url')+'.json')});
const projects=[{id:'synthetic-account',name:'Demo renovation · Bathroom + Kitchen',notes:'Synthetic demo only. Original notes remain separate.',schedule:[],todos:[],toBuy:[]}];
const env={ENABLE_FINANCE_REVIEW:'true',FINANCE_ACCOUNTS:namespace,DOTY_KV:{get:async key=>{if(key!=='data:demo-owner')return null;let data={projects};try{data=JSON.parse(await fs.readFile(path.join(dataRoot,'.preview','restored-tracker.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}return JSON.stringify({data});}}};
const ctx={env,username:'demo-owner',role:'admin'};
const rows=[
 {kind:'expense',vendor:'Demo supply',category:'Materials',phase:'Bathroom',amount:'120.50',tax:'',clientCharge:'atCost',purchasedBy:'project',receipt:'DEMO-1'},
 {kind:'expense',vendor:'Demo tile',category:'Materials',phase:'Kitchen',amount:'80.25',tax:'',clientCharge:'atCost',purchasedBy:'project',receipt:'DEMO-2'},
 {kind:'expense',vendor:'Client supplied fixture (demo)',category:'Materials',phase:'Kitchen',amount:'75.00',tax:'',clientCharge:'none',purchasedBy:'client',receipt:'DEMO-CLIENT'},
 {kind:'labour',person:'Lead (demo)',phase:'Bathroom',unit:'days',quantity:'1.5',billRate:'600.00',payRate:''},
 {kind:'labour',person:'Worker (demo)',phase:'Kitchen',unit:'days',quantity:'2.5',billRate:'500.00',payRate:'350.00'},
 {kind:'clientPayment',phase:'Bathroom',amount:'1500.00'},
 {kind:'workerPayout',person:'Worker (demo)',phase:'Kitchen',amount:'350.00'}
].map((r,i)=>({...r,date:'2026-09-01',currency:'CAD',description:'Synthetic demo',provenance:{reference:'Synthetic fixture '+i,text:'Synthetic demo transaction',sourceId:'synthetic-seed-'+i}}));
// Only seed a genuinely empty local demo store; never reset previous demo edits.
const demoPeople=await peopleAccess(ctx);if(demoPeople.revision===0){let revision=0;for(const name of ['Lead (demo)','Worker (demo)']){const result=await peopleAccess(ctx,{action:'personAdd',previousRevision:revision,operationId:'synthetic-person-'+revision,name});revision=result.ledger.revision;}}
if((JSON.parse(await env.DOTY_KV.get('data:demo-owner')).data.projects||[]).some(p=>p.id==='synthetic-account')){
const initial=await financeAccess(ctx,{project_id:'synthetic-account'},false);
if(initial.revision===0){
 let revision=0;const phaseIds=new Map();
 for(const name of ['Bathroom','Kitchen']){const result=await financeAccess(ctx,{project_id:'synthetic-account',mutation:{action:'phaseAdd',previousRevision:revision,operationId:'synthetic-phase-'+name,name}},true,'browser');revision=result.ledger.revision;phaseIds.set(name,result.result.phaseIds[0]);}
 const seedPeople=await peopleAccess(ctx);
 await financeAccess(ctx,{project_id:'synthetic-account',mutation:{action:'add',previousRevision:revision,operationId:'synthetic-initial-seed',rows:rows.map(r=>({...r,phaseId:phaseIds.get(r.phase)})).map(r=>({...r,...(['labour','workerPayout'].includes(r.kind)?{personId:seedPeople.people.find(p=>p.name===r.person).id}:{})}))}},true,'browser');
}
}
const backup=new LocalBackupService({root:dataRoot,namespace});
let apiQueue=Promise.resolve();
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.md':'text/plain; charset=utf-8'};
const send=(res,status,body,type='application/json')=>{res.writeHead(status,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(type==='application/json'?JSON.stringify(body):body);};
async function body(req){const chunks=[];let count=0;for await(const chunk of req){count+=chunk.length;if(count>20000000)throw Error('Payload too large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString());}
async function handle(req,res){
 try{
  const host=req.headers.host;
  if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return send(res,403,{error:'Local host required'});
  if(req.headers.origin&&!['http://127.0.0.1:'+port,'http://localhost:'+port].includes(req.headers.origin))return send(res,403,{error:'Cross-origin local request refused'});
  const url=new URL(req.url,'http://'+host);
  let requestCtx=ctx;if(req.headers['x-review-projects']){const localProjects=JSON.parse(req.headers['x-review-projects']);if(!Array.isArray(localProjects)||localProjects.length>10000||localProjects.some(p=>typeof p.id!=='string'))throw Error('Invalid local project context');requestCtx={...ctx,env:{...env,DOTY_KV:{get:async key=>key==='data:demo-owner'?JSON.stringify({data:{projects:localProjects}}):null}}};}
  if(url.pathname==='/local-backup'){if(req.method!=='POST')return send(res,405,{error:'POST required'});const b=await body(req);let value;if(b.action==='export')value=await backup.export(b.tracker);else if(b.action==='prepare')value=await backup.prepare(b.bundle,b.tracker,b.expected);else if(b.action==='apply')value=await backup.apply(b.token,b.tracker);else if(b.action==='status')value=await backup.status(b.token);else return send(res,400,{error:'Unknown backup action'});return send(res,200,value);}
  if(url.pathname==='/local-finance/contacts'){if(!['GET','POST'].includes(req.method))return send(res,405,{error:'Method not allowed'});const b=req.method==='POST'?await body(req):null;return send(res,200,await contactsAccess(requestCtx,req.method==='GET'?{search:url.searchParams.get('search')||''}:{},b?.mutation||null));}
  if(url.pathname==='/local-finance/people'){if(!['GET','POST'].includes(req.method))return send(res,405,{error:'Method not allowed'});const b=req.method==='POST'?await body(req):null;if(b&&Object.keys(b).some(k=>k!=='mutation'))return send(res,400,{error:'Invalid People request'});return send(res,200,await peopleAccess(ctx,b?.mutation||null));}
  if(url.pathname==='/local-finance/review'){
   if(!['GET','POST'].includes(req.method))return send(res,405,{error:'Method not allowed'});
   const args=req.method==='GET'?{project_id:url.searchParams.get('project_id')}:await body(req);
   return send(res,200,await financeAccess(requestCtx,args,req.method==='POST','browser'));
  }
  if(url.pathname==='/local-mcp'){
   if(req.method!=='POST')return send(res,405,{error:'POST required'});
   const rpc=await body(req);
   if(rpc.jsonrpc!=='2.0')return send(res,400,{error:'Invalid JSON-RPC'});
   try{
    let result;
    if(rpc.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'doty-synthetic-local-preview',version:'1'}};
    else if(rpc.method==='tools/list')result={tools:FINANCE_TOOLS};
    else if(rpc.method==='tools/call'){const value=await callFinanceTool(rpc.params?.name,rpc.params?.arguments||{},ctx);result={content:[{type:'text',text:JSON.stringify(value)}]};}
    else throw Error('Unknown method');
    return send(res,200,{jsonrpc:'2.0',id:rpc.id,result});
   }catch(e){return send(res,200,{jsonrpc:'2.0',id:rpc.id,error:{code:e.status===409?-32009:-32602,message:e.message}});}
  }
  if(req.method!=='GET')return send(res,405,{error:'Method not allowed'});
  const file=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
  // Serve only the app's public review assets, never local ledger files or backend source.
  if(path.dirname(file)!==root||!['index.html','ledger.js','ledger-ui.js','ledger.css','finance-client.js','people-ui.js','contacts-ui.js','backup.js','backup-ui.js','doty-logo-white-bg.png','doty-logo-black-bg.png','preview-mobile.jpg','preview-desktop.jpg'].includes(path.basename(file)))return send(res,404,{error:'Not found'});
  send(res,200,await fs.readFile(file),types[path.extname(file)]||'application/octet-stream');
 }catch(e){send(res,e.status||400,{error:e.message});}
}
const server=http.createServer((req,res)=>{if(req.url.startsWith('/local-')){const run=apiQueue.catch(()=>{}).then(()=>handle(req,res));apiQueue=run;}else handle(req,res);});
server.listen(port,'127.0.0.1',()=>{port=server.address().port;console.log(`Synthetic shared preview: http://127.0.0.1:${port}/?demo&sync\nLocal conversational endpoint: http://127.0.0.1:${port}/local-mcp\nData: .preview/ (ignored, synthetic only). No production network access.`);});
