/* Local-only financial ledger. Deliberately excluded from synced project state. */
(function(root){
'use strict';
const kinds=['expense','labour','clientPayment','workerPayout'];
const cents=n=>{if(!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(n))) throw Error('Use a non-negative amount with at most two decimals.');const [a,b='']=String(n).split('.');const v=Number(a)*100+Number(b.padEnd(2,'0'));if(!Number.isSafeInteger(v))throw Error('Amount too large.');return v;};
function validate(r){
 if(!kinds.includes(r.kind))throw Error('Unknown transaction kind.');
 if(r.billingVersion!==undefined&&r.billingVersion!=='2')throw Error('Unsupported expense billing version.');
 if(!/^[A-Z]{3}$/.test(r.currency||''))throw Error('Currency requires three capital letters.');
 if(r.date && (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||new Date(r.date+'T00:00:00Z').toISOString().slice(0,10)!==r.date))throw Error('Invalid date.');
 if(r.phase!=null&&typeof r.phase!=='string')throw Error('Legacy phase must be text.');if(r.phaseId!=null&&typeof r.phaseId!=='string')throw Error('Phase ID must be text.');
 if(r.kind==='labour'){
  if(!(r.person?.trim()||r.personId?.trim())||!['days','hours'].includes(r.unit))throw Error('Person and unit required.');
  if(!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(String(r.quantity))||Number(r.quantity)<=0)throw Error('Positive quantity required (up to two decimals).');
  cents(r.quantity); lineCost(r.billRate,r.quantity); if(r.payRate!==''&&r.payRate!=null)lineCost(r.payRate,r.quantity);
  cents(r.billRate); if(r.payRate!==''&&r.payRate!=null)cents(r.payRate);
 }else {cents(r.amount);if(r.kind==='expense'){if(r.purchasedBy==='client'&&r.clientCharge!=='none')throw Error('Client-purchased costs cannot be charged again.');if(!['atCost','markup','none'].includes(r.clientCharge))throw Error('Choose expense client pricing.');if(!r.vendor?.trim()||!r.category?.trim())throw Error('Vendor and category required.');if(r.tax!==''&&r.tax!=null&&cents(r.tax)>cents(r.amount))throw Error('Included tax cannot exceed total.');}if(r.kind==='expense'){expensePricing(r);if(r.billingVersion==='2'){const expected=expenseSnapshot(r);for(const field of ['purchaseGross','purchaseTax','purchaseSubtotal','clientPreTax','clientTax','clientGross','clientTaxRate'])if(r[field]!==undefined&&r[field]!==expected[field])throw Error('Recorded billing breakdown does not match its rate/tax snapshot.');}}if(r.kind==='workerPayout'&&!(r.person?.trim()||r.personId?.trim()))throw Error('Person required.');}
 return r;
}
function safeInteger(value){const n=Number(value);if(!Number.isSafeInteger(n))throw Error('Account total too large.');return n;}
function lineCost(rate,quantity){
 const product=BigInt(cents(rate))*BigInt(cents(quantity));
 const value=Number((product+50n)/100n);
 if(!Number.isSafeInteger(value))throw Error('Labour line too large.');
 return value;
}
function markupRate(value){const rate=cents(value);if(rate>100000)throw Error('Markup must be between 0 and 1000%, with at most two decimals.');return rate;}
function expenseDefaults(input){const rate=String(input?.markupRate??'0.00'),base=input?.markupBase||'net',mode=input?.clientTaxMode||'hst13';markupRate(rate);if(!['','net','gross'].includes(base))throw Error('Invalid markup base.');if(!['hst13','none','manual'].includes(mode))throw Error('Choose client HST, no client tax, or manual client tax.');return {markupRate:rate,markupBase:base,clientTaxMode:mode};}
function expensePricing(row){const cost=cents(row.amount);if(row.clientCharge==='none')return {cost,markup:0,clientCharge:0,clientPreTax:0,clientTax:0};
 if(row.billingVersion==='2'){
  if(row.tax===''||row.tax==null)throw Error('Record the receipt purchase tax explicitly (0 if verified tax-free). It cannot be inferred from gross cost.');const purchaseTax=cents(row.tax);if(purchaseTax>cost)throw Error('Included tax cannot exceed cost.');const purchaseSubtotal=cost-purchaseTax,rate=row.clientCharge==='atCost'?0:markupRate(row.markupRate);if(row.markupBase!=='net')throw Error('New expense markup applies to the purchase subtotal before tax.');const markup=safeInteger((BigInt(purchaseSubtotal)*BigInt(rate)+5000n)/10000n),clientPreTax=safeInteger(BigInt(purchaseSubtotal)+BigInt(markup));let clientTax;if(row.clientTaxMode==='hst13')clientTax=safeInteger((BigInt(clientPreTax)*1300n+5000n)/10000n);else if(row.clientTaxMode==='none')clientTax=0;else if(row.clientTaxMode==='manual'){if(row.clientTaxAmount===''||row.clientTaxAmount==null)throw Error('Enter explicit manual client tax.');clientTax=cents(row.clientTaxAmount);}else throw Error('Choose an explicit client tax treatment.');return {cost,purchaseSubtotal,purchaseTax,markup,clientPreTax,clientTax,clientCharge:safeInteger(BigInt(clientPreTax)+BigInt(clientTax))};
 }
 // Compatibility only: retain original historical at-cost/older explicit markup semantics.
 if(row.clientCharge==='atCost')return {cost,markup:0,clientCharge:cost};const rate=markupRate(row.markupRate);let base=cost;if(rate>0){if(!['gross','net'].includes(row.markupBase))throw Error('Choose an explicit markup base.');if(row.markupBase==='net'){if(row.tax===''||row.tax==null)throw Error('Included tax must be known for a before-tax markup base.');const tax=cents(row.tax);if(tax>cost)throw Error('Included tax cannot exceed cost.');base-=tax;}}const markup=safeInteger((BigInt(base)*BigInt(rate)+5000n)/10000n);return {cost,markup,clientCharge:safeInteger(BigInt(cost)+BigInt(markup))};}
function decimalAmount(n){return Math.floor(n/100)+'.'+String(n%100).padStart(2,'0');}
function expenseSnapshot(row){if(row.kind!=='expense'||row.billingVersion!=='2')return row;const price=expensePricing(row);const out={...row,markupRate:row.clientCharge==='atCost'?'0.00':row.markupRate,markupBase:'net',purchaseGross:row.amount,...(row.tax!==''&&row.tax!=null?{purchaseTax:row.tax,purchaseSubtotal:decimalAmount(cents(row.amount)-cents(row.tax))}:{}),clientPreTax:decimalAmount(price.clientPreTax),clientTax:decimalAmount(price.clientTax),clientGross:decimalAmount(price.clientCharge),clientTaxRate:row.clientCharge==='none'||row.clientTaxMode==='none'?'0.00':row.clientTaxMode==='hst13'?'13.00':''};return out;}
function totals(rows){
 const out=Object.create(null);
 for(const r of rows.filter(r=>!r.voided)){
  validate(r);const t=out[r.currency] ||= {expenses:0,chargeableExpenses:0,expenseMarkup:0,clientExpenseTax:0,unknownExpenseTax:0,billable:0,clientPayments:0,workerPay:0,workerPayouts:0,unknownPay:0,workers:Object.create(null)};
  if(r.kind==='expense'){const price=expensePricing(r);t.expenses+=price.cost;t.chargeableExpenses+=price.clientCharge;t.expenseMarkup+=price.markup;if(price.clientTax!==undefined)t.clientExpenseTax+=price.clientTax;else if(r.clientCharge!=='none')t.unknownExpenseTax++;}
  if(r.kind==='clientPayment')t.clientPayments+=cents(r.amount);
  if(r.kind==='labour'){
   t.billable+=lineCost(r.billRate,r.quantity);
   const w=t.workers[r.personId?'id:'+r.personId:'legacy:'+r.person] ||= {earned:0,paid:0,unknown:0};
   if(r.payRate===''||r.payRate==null){t.unknownPay++;w.unknown++;}else{const pay=lineCost(r.payRate,r.quantity);t.workerPay+=pay;w.earned+=pay;}
  }
  if(r.kind==='workerPayout'){t.workerPayouts+=cents(r.amount);(t.workers[r.personId?'id:'+r.personId:'legacy:'+r.person] ||= {earned:0,paid:0,unknown:0}).paid+=cents(r.amount);}
 }
 for(const t of Object.values(out)){for(const key of ['expenses','chargeableExpenses','expenseMarkup','clientExpenseTax','billable','clientPayments','workerPay','workerPayouts'])if(!Number.isSafeInteger(t[key]))throw Error('Account total too large.');t.accountBalance=safeInteger(BigInt(t.chargeableExpenses)+BigInt(t.billable)-BigInt(t.clientPayments));t.workerOutstanding=safeInteger(BigInt(t.workerPay)-BigInt(t.workerPayouts));for(const w of Object.values(t.workers)){safeInteger(BigInt(w.earned));safeInteger(BigInt(w.paid));safeInteger(BigInt(w.earned)-BigInt(w.paid));}}
 return out;
}
function isSnapshot(row){
 if(row.recordType==='evidence')return true;
 return /\b(cumulative|snapshot|running\s+total|(?:materials?|expenses?|labou?r|payments?|payouts?|costs?)\s+total|total\s+(?:materials?|expenses?|labou?r|payments?|payouts?|costs?|paid)|total\s+to\s+date|(?:expenses?|materials?|labou?r|costs?|payments?|balance)\s+to\s+date|balance\s+(?:to\s+date|as\s+of))\b/i.test(row.provenance?.text||'');
}
function phaseName(value){
 if(typeof value!=='string')throw Error('Phase name required.');
 const name=value.normalize('NFC').trim().replace(/\s+/g,' ');
 if(!name||name.length>120)throw Error('Phase name requires 1–120 characters.');
 return name;
}
function phaseKey(value){return phaseName(value).toLocaleLowerCase('en-CA');}
function upgradePhases(data,newId){
 if(data.phaseSchemaVersion===1)return false;
 data.phases=data.phases||[];const names=new Map(data.phases.map(p=>[phaseKey(p.name),p]));
 const records=[...(data.rows||[]),...(data.proposals||[]).map(p=>p.row),...(data.proposalHistory||[]).map(p=>p.row),...(data.checkpoints||[])];
 for(const row of records){
  if(row.phaseId&&data.phases.some(p=>p.id===row.phaseId))continue;
  if(row.phaseId){row.phaseNeedsReview=true;continue;}
  if(!row.phase?.trim()){row.phaseId=null;continue;}
  let name;try{name=phaseName(row.phase);}catch{row.phaseId=null;row.phaseNeedsReview=true;continue;}
  const key=phaseKey(name);let phase=names.get(key);
  if(!phase){phase={id:newId(),name,createdFromLegacy:true};names.set(key,phase);data.phases.push(phase);}
  row.phaseId=phase.id;
 }
 data.phaseSchemaVersion=1;return true;
}
function phaseLabel(data,row){return data.phases?.find(p=>p.id===row.phaseId)?.name||'Unassigned';}
function resolvePhase(data,row,allowUnassigned=false){
 if(row.phaseId){const p=data.phases.find(p=>p.id===row.phaseId);if(p)return p.id;if(!allowUnassigned)throw Error('Unknown phase ID. Select a phase from this project.');}
 if(allowUnassigned&&row.phase?.trim()){const p=data.phases.find(p=>phaseKey(p.name)===phaseKey(row.phase));if(p)return p.id;}
 if(allowUnassigned)return null;
 throw Error('Select a project phase. Add one in Phases first.');
}
function personLabel(data,row){return data.people?.find(p=>p.id===row.personId)?.name||row.person||'Unassigned person';}
function resolvePerson(data,row,staged=false,allowArchived=false){
 if(!['labour','workerPayout'].includes(row.kind))return null;
 if(row.personId){const p=data.people?.find(p=>p.id===row.personId);if(p){if(p.archived&&!staged&&!allowArchived)throw Error('Person is archived. Restore them before a new booking, or review a verified historical proposal.');return p.id;}if(!staged)throw Error('Unknown person ID. Select an account person.');}
 if(staged&&row.person?.trim()){const p=data.people?.find(p=>phaseKey(p.name)===phaseKey(row.person));if(p)return p.id;}
 if(staged)return null;throw Error('Select an account person. Add one in Labour → People first.');
}
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(new Date(value+'T00:00:00Z').getTime())&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;}
function personWages(input){const out={};for(const key of ['wageDay','wageHour'])if(input[key]!==undefined){if(typeof input[key]!=='string')throw Error('Wage defaults must be text amounts or blank.');if(input[key]!=='')cents(input[key]);out[key]=input[key];}if(input.wageCurrency!==undefined){if(typeof input.wageCurrency!=='string'||!/^[A-Z]{3}$/.test(input.wageCurrency))throw Error('Wage currency requires three capital letters.');out.wageCurrency=input.wageCurrency;}if(input.wageEffectiveDate!==undefined){if(!validDate(input.wageEffectiveDate))throw Error('Valid wage effective date required.');out.wageEffectiveDate=input.wageEffectiveDate;}if(Object.keys(out).length&&(!out.wageCurrency||!out.wageEffectiveDate))throw Error('Wage defaults require a currency and effective date.');return out;}
function wageFor(person,unit,currency,date){if(!validDate(date))return {value:'',reason:'Choose a work date to use an effective wage.'};if(!['days','hours'].includes(unit)||!/^[A-Z]{3}$/.test(currency||''))return {value:'',reason:'Known unit and currency required.'};const applicable=(person?.wageHistory||[]).filter(w=>w.currency===currency&&w.effectiveDate<=date).sort((a,b)=>b.effectiveDate.localeCompare(a.effectiveDate)||(b.revision||0)-(a.revision||0))[0];if(!applicable)return {value:'',reason:'No wage history for this date and currency. Pay remains unknown unless entered explicitly.'};const value=unit==='days'?applicable.day:applicable.hour;return {value:value==null?'':value,scheduleId:applicable.id,effectiveDate:applicable.effectiveDate,reason:value==null||value===''?'No '+unit+' wage recorded on the applicable schedule.':''};}
function wageDefault(person,unit,currency,date){return person?.archived?'':wageFor(person,unit,currency,date).value;}
function workerLabel(data,key){if(key.startsWith('legacy:'))return 'Unassigned · '+key.slice(7);if(key.startsWith('id:')){const id=key.slice(3),person=data.people?.find(p=>p.id===id);if(person)return person.name+(person.archived?' · Archived':'');const source=data.rows?.find(r=>r.personId===id&&r.person);return (source?.person||'Unknown person')+' · directory unavailable';}return key;}
function accountCurrency(data){return data.currency||([ ...new Set(data.rows.filter(r=>!r.voided).map(r=>r.currency)) ].length===1?data.rows.find(r=>!r.voided).currency:null);}
function warnings(r,rows){
 const w=[];const source=r.provenance?.text||'';
 if(!r.date)w.push('Undated: confirm this is a separate occurrence.');
 if(/total|balance|cumulative|snapshot|to date|running/i.test(source))w.push('Possible running total: exclude snapshots, never book them as transactions.');
 if(/correct|replace|amend|instead|duplicate/i.test(source))w.push('Possible correction: identify and void the superseded row before accepting.');
 if(r.provenance?.sourceId&&rows.some(x=>!x.voided&&x.provenance?.sourceId===r.provenance.sourceId))w.push('Source occurrence already exists. Review the existing row or use an explicit correction.');
 const fields=['kind','clientCharge','currency','date','phase','amount','vendor','person','unit','quantity','billRate','payRate'];
 if(rows.some(x=>!x.voided&&fields.every(k=>(x[k]||'')===(r[k]||''))))w.push('Similar row exists. Repeated undated days can be legitimate; confirm occurrence.');
 if(!r.provenance?.text||!r.provenance?.reference)w.push('Missing source text or reference.');
 return w;
}
const api={expenseSnapshot,decimalAmount,markupRate,expenseDefaults,expensePricing,cents,validate,totals,warnings,lineCost,isSnapshot,phaseName,phaseKey,upgradePhases,phaseLabel,resolvePhase,personLabel,resolvePerson,accountCurrency,personWages,wageDefault,wageFor,validDate,workerLabel};root.DotyLedger=api;if(typeof module!=='undefined')module.exports=api;
})(globalThis);
