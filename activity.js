"use strict";
const $=s=>document.querySelector(s);
const SOURCE="https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0/query";
const STORAGE="radharc.major-schemes.edits.v1";
const ACP_SOURCE="https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/ArcGIS/rest/services/Cases_2016_Onwards/FeatureServer/3";
const CATS=[
 ["submitted","Submitted","#287bb4","ReceivedDate"],
 ["granted","Granted","#319668","GrantDate"],
 ["withdrawn","Withdrawn","#887f77","WithdrawnDate"],
 ["refused","Refused","#cf4848","DecisionDate"],
 ["appealed","Lodged to appeal","#7a59b3","AppealSubmittedDate"],
 ["appealGranted","Granted on appeal","#268b6a","AppealDecisionDate"],
 ["started","Started (BCMS)","#697f8c",null]
];
const DAY=86400000;
const today=new Date();
const end=new Date(today.getFullYear(),today.getMonth(),today.getDate()+1);
const start=new Date(end.getTime()-28*DAY);
const fmt=n=>new Intl.NumberFormat("en-IE").format(n||0);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clean=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]/g,"");
const key=(authority,ref)=>"planning|"+clean(authority)+"|"+clean(ref);
const dateValue=v=>{
 if(v==null||v==="")return 0;
 if(typeof v==="number")return v<1e11?v*1000:v;
 if(/^\d{12,}$/.test(String(v)))return Number(v);
 const d=Date.parse(String(v));return Number.isFinite(d)?d:0;
};
const dateText=v=>{const t=dateValue(v);return t?new Date(t).toLocaleDateString("en-IE",{day:"2-digit",month:"short",year:"numeric"}):"—"};
const isoDay=v=>new Date(v).toISOString().slice(0,10);
const inWindow=v=>{const t=dateValue(v);return t>=start.getTime()&&t<end.getTime()};
const safeUrl=v=>{try{const u=new URL(String(v||""));return ["http:","https:"].includes(u.protocol)&&u.hostname.includes(".")&&!u.username&&!u.password?u.href:""}catch{return""}};
const lower=v=>String(v||"").toLowerCase();
let records=[],events=[],catalogue=[],active="submitted",eventLimit=60,historyLimit=75,chartData=[],loading=false,partialErrors=[];
let localEdits={};
try{localEdits=JSON.parse(localStorage.getItem(STORAGE)||"{}")||{}}catch{}
function applyEdit(p){
 const edit=localEdits[p.key];
 if(edit&&typeof edit==="object"){
  for(const f of ["applicant","companyGroup","developer","siteName","units","authority","reference","route","tags","received","councilGrantDate","acpLodgedDate","acpDecisionDate","acpOutcome","finalGrantDate","evidenceUrl","notes","website","decisionDueDate","fiRequestDate","fiReceivedDate"]){
   if(edit[f]!==undefined&&edit[f]!==null&&edit[f]!=="")p[f]=edit[f];
  }
  p.edited=true;
 }
 return p;
}
function extractApplicant(p){
 const fromFields=[p.ApplicantForename,p.ApplicantSurname].filter(Boolean).join(" ").trim();
 return fromFields;
}
function makeRecord(p){
 const authority=String(p.PlanningAuthority||"").trim();
 const ref=String(p.ApplicationNumber||"").trim();
 return {
  key:key(authority,ref),kind:"planning",authority,reference:ref,
  units:Number(p.NumResidentialUnits)||0,siteName:p.DevelopmentAddress||"Residential scheme",
  address:p.DevelopmentAddress||"",description:p.DevelopmentDescription||"",
  applicant:extractApplicant(p),received:p.ReceivedDate,decision:p.Decision||"",
  councilGrantDate:p.GrantDate,finalGrantDate:null,
  councilDecisionDate:p.DecisionDate,withdrawnDate:p.WithdrawnDate,
  decisionDueDate:p.DecisionDueDate,fiRequestDate:p.FIRequestDate,fiReceivedDate:p.FIRecDate,
  acpLodgedDate:p.AppealSubmittedDate,acpDecisionDate:p.AppealDecisionDate,
  acpOutcome:p.AppealDecision||"",appealStatus:p.AppealStatus||"",
  appealRef:p.AppealRefNumber||"",source:p.LinkAppDetails||"",type:p.ApplicationType||"",
  raw:p
 };
}
function mergeCatalog(p,cat){
 if(!cat)return p;
 const copy={...p};
 for(const field of ["siteName","applicant","companyGroup","developer","brand","tags","route","type","category","website","projectWebsite","siteWebsiteSource","applicantSource","planningReference","possibleDuplicateOf"]){
  if(cat[field])copy[field]=cat[field];
 }
 if(cat.units&&!p.units)copy.units=cat.units;
 if(cat.source&&!p.source)copy.source=cat.source;
 if(cat.address&&!p.address)copy.address=cat.address;
 if(cat.received&&!p.received)copy.received=cat.received;
 for(const f of ["councilGrantDate","acpLodgedDate","acpDecisionDate","finalGrantDate","fiRequestDate","fiReceivedDate","decisionDueDate"]){
  if(cat[f]&&!p[f])copy[f]=cat[f];
 }
 return copy;
}
function enrichFromCatalogue(p,map,acpByCase){
 const cat=map.get(p.key);
 if(cat)p=mergeCatalog(p,cat);
 const caseId=clean(p.appealRef).match(/\d{6}/)?.[0];
 const acp=caseId&&acpByCase.get(caseId);
 if(acp){
  if(!p.applicant&&acp.applicant)p.applicant=acp.applicant;
  if(!p.acpLodgedDate&&acp.received)p.acpLodgedDate=acp.received;
  if(!p.acpOutcome&&acp.decision)p.acpOutcome=acp.decision;
  if(!p.acpDecisionDate&&acp.acpDecisionDate)p.acpDecisionDate=acp.acpDecisionDate;
  p.acpCaseUrl=acp.source||"https://www.pleanala.ie/en-ie/case/"+caseId;
 }
 if(p.appealRef&&!p.acpCaseUrl&&caseId)p.acpCaseUrl="https://www.pleanala.ie/en-ie/case/"+caseId;
 // Council grant is not a final grant while an appeal is pending.
 const appealed=!!dateValue(p.acpLodgedDate)||!!p.appealRef;
 const appealGranted=/\b(grant\w*|approv\w*|permission)\b/i.test(String(p.acpOutcome||""))&&!/\b(refus|reject|quash)\b/i.test(String(p.acpOutcome||""));
 if(!p.finalGrantDate){
  if(appealed){
   if(appealGranted&&dateValue(p.acpDecisionDate))p.finalGrantDate=p.acpDecisionDate;
  }else if(dateValue(p.councilGrantDate))p.finalGrantDate=p.councilGrantDate;
 }
 return applyEdit(p);
}
function projectWebsite(p){
 for(const v of [p.projectWebsite,p.website,p.siteWebsiteSource,p.developerSource]){
  const u=safeUrl(v);
  if(u&&!/(?:pleanala\.ie|arcgis\.com|agileapplications\.ie|eplanning\.ie)/i.test(u))return u;
 }
 const match=String(p.description||"").match(/(?:https?:\/\/|www\.)[^\s<>"')]+/ig)||[];
 for(const raw of match){const u=safeUrl(/^www\./i.test(raw)?"https://"+raw:raw);if(u)return u}
 return "";
}
function searchUrl(p){
 const term=[p.siteName,p.address,p.authority,"LRD planning website"].filter(Boolean).join(" ");
 return "https://www.google.com/search?q="+encodeURIComponent(term.slice(0,160));
}
function normalizeCatalogue(p){
 const rec={...p};
 rec.key=p.key||key(p.authority,p.reference);
 rec.councilGrantDate=p.councilGrantDate||p.grantDate||"";
 rec.acpLodgedDate=p.acpLodgedDate||"";
 rec.acpDecisionDate=p.acpDecisionDate||"";
 rec.acpOutcome=p.acpOutcome||(p.kind==="acp"?p.decision:"")||"";
 rec.fiRequestDate=p.fiRequestDate||"";
 rec.fiReceivedDate=p.fiReceivedDate||"";
 rec.decisionDueDate=p.decisionDueDate||"";
 return rec;
}
function classify(p){
 const out=[];
 const refused=/\b(refus|reject|deny)\w*/i.test(p.decision||"");
 const isAppeal=p.kind!=="acp"||Boolean(p.isAppeal||p.possibleDuplicateOf||p.planningReference);
 const appealGranted=/\b(grant\w*|approv\w*|permission)\b/i.test(p.acpOutcome||"")&&!/\b(refus|reject|quash)\b/i.test(p.acpOutcome||"");
 if(p.kind!=="acp"&&inWindow(p.received))out.push(["submitted",p.received]);
 if(p.kind!=="acp"&&inWindow(p.councilGrantDate)&&!refused)out.push(["granted",p.councilGrantDate]);
 if(inWindow(p.withdrawnDate))out.push(["withdrawn",p.withdrawnDate]);
 if(inWindow(p.councilDecisionDate)&&refused)out.push(["refused",p.councilDecisionDate]);
 if(isAppeal&&inWindow(p.acpLodgedDate||((p.kind==="acp")?p.received:null)))out.push(["appealed",p.acpLodgedDate||p.received]);
 if(isAppeal&&inWindow(p.acpDecisionDate)&&appealGranted)out.push(["appealGranted",p.acpDecisionDate]);
 // A project is never marked started without a verified BCMS project match.
 if(inWindow(p.bcmsCommencementDate)&&p.bcmsEvidenceUrl)out.push(["started",p.bcmsCommencementDate]);
 return out.map(([status,when])=>({status,when,p}));
}
function drawCharts(){
 const scoped=events.filter(e=>matchesAuthority(e.p));
 const labels=CATS.map(x=>x[1]),colors=CATS.map(x=>x[2]);
 const values=CATS.map(x=>scoped.filter(e=>e.status===x[0]).length);
 paint("eventChart",ctx=>{
  const {w,h}=ctx;const left=115,right=36,top=12,row=27,maximum=Math.max(1,...values);
  labels.forEach((label,i)=>{
   const y=top+i*row;
   ctx.fillStyle="#496474";ctx.font="12px system-ui";ctx.textAlign="right";ctx.fillText(label,left-9,y+17);
   ctx.fillStyle="#eaf1f5";ctx.fillRect(left,y+4,w-left-right,17);
   const width=(w-left-right)*values[i]/maximum;
   ctx.fillStyle=colors[i];ctx.fillRect(left,y+4,width,17);
   ctx.fillStyle="#244b60";ctx.textAlign="left";ctx.fillText(String(values[i]),Math.min(w-27,left+width+6),y+17);
  });
 });
 const days=Array.from({length:28},(_,i)=>isoDay(start.getTime()+i*DAY));
 const counts=days.map(d=>scoped.filter(e=>e.status==="submitted"&&isoDay(dateValue(e.when))===d).length);
 paint("lodgementChart",ctx=>{
  const {w,h}=ctx;const pad=20,baseline=h-29,maximum=Math.max(1,...counts),bw=(w-2*pad)/28;
  ctx.strokeStyle="#d7e4e9";ctx.beginPath();ctx.moveTo(pad,baseline);ctx.lineTo(w-pad,baseline);ctx.stroke();
  counts.forEach((n,i)=>{ctx.fillStyle="#287bb4";ctx.fillRect(pad+i*bw+1,baseline-(baseline-18)*n/maximum,Math.max(2,bw-3),(baseline-18)*n/maximum)});
  ctx.fillStyle="#627b89";ctx.font="11px system-ui";ctx.textAlign="left";ctx.fillText(days[0].slice(5),pad,h-9);ctx.textAlign="right";ctx.fillText(days[27].slice(5),w-pad,h-9);
  ctx.textAlign="left";ctx.fillText("Max "+maximum+" / day",pad,14);
 });
}
function paint(id,fn){
 const canvas=$("#"+id);if(!canvas)return;
 const w=Math.max(330,canvas.getBoundingClientRect().width||550),h=220,dpr=Math.min(2,window.devicePixelRatio||1);
 canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
 const c=canvas.getContext("2d");c.scale(dpr,dpr);c.clearRect(0,0,w,h);
 fn({w,h,fillRect:(...x)=>c.fillRect(...x),fillText:(...x)=>c.fillText(...x),
  moveTo:(...x)=>c.moveTo(...x),lineTo:(...x)=>c.lineTo(...x),beginPath:()=>c.beginPath(),stroke:()=>c.stroke(),
  set fillStyle(v){c.fillStyle=v},set strokeStyle(v){c.strokeStyle=v},set font(v){c.font=v},set textAlign(v){c.textAlign=v}});
}
function matchesAuthority(p){
 const authority=$("#authority").value,min=Math.max(101,Number($("#minUnits").value)||101);
 return (!authority||p.authority===authority)&&Number(p.units)>=min;
}
function matchesSearch(p,term){
 return !term||[p.siteName,p.address,p.description,p.applicant,p.companyGroup,p.developer,p.authority,p.reference,p.appealRef,p.type,p.route,p.tags].some(v=>lower(Array.isArray(v)?v.join(" "):v).includes(term));
}
function metricRender(){
 const scoped=events.filter(e=>matchesAuthority(e.p));
 $("#metrics").innerHTML=CATS.map(([id,label])=>{
  const n=scoped.filter(e=>e.status===id).length;
  return '<button class="metric '+(id===active?'active':'')+'" data-status="'+id+'" type="button" aria-pressed="'+(id===active)+'"><span>'+esc(label)+'</span><b>'+fmt(n)+'</b><small>'+ (id==="started"?"Verified matches only":"Last 28 days")+'</small></button>';
 }).join("");
 $("#metrics").querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>{active=b.dataset.status;eventLimit=60;render()}));
}
function detailMarkup(p){
 const official=safeUrl(p.source),acp=safeUrl(p.acpCaseUrl),website=projectWebsite(p);
 const link=(url,label)=>url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+esc(label)+' ↗</a>':"";
 const reference=official?link(official,"Application "+(p.reference||"")):esc(p.reference||"No reference");
 const websiteLink=website?link(website,"Project website"):link(searchUrl(p),"Search for project website");
 const fi=p.fiRequestDate?"FI requested "+dateText(p.fiRequestDate)+(p.fiReceivedDate?", received "+dateText(p.fiReceivedDate):""):"No FI request recorded";
 return '<div class="linkline">'+reference+' '+link(acp,"ACP case")+' '+websiteLink+'</div>'+
  '<details><summary class="detail-toggle">Dates &amp; source details</summary><div class="detail-box">'+
  '<p>Received: '+dateText(p.received)+' · Council decision: '+dateText(p.councilDecisionDate)+' · Council grant: '+dateText(p.councilGrantDate)+'</p>'+
  '<p>'+esc(fi)+' · Decision due: '+dateText(p.decisionDueDate)+'</p>'+
  '<p>Appeal lodged: '+dateText(p.acpLodgedDate)+' · ACP decision: '+dateText(p.acpDecisionDate)+' · Final grant: '+dateText(p.finalGrantDate)+'</p>'+
  '<p>Appeal outcome: '+esc(p.acpOutcome||"Not recorded")+' · '+esc(p.type||p.route||"Residential")+'</p>'+
  '</div></details>';
}
function eventRow(e){
 const p=e.p;
 const label=CATS.find(x=>x[0]===e.status)?.[1]||e.status;
 const fi=p.fiRequestDate?'Requested '+dateText(p.fiRequestDate)+(p.fiReceivedDate?' · received '+dateText(p.fiReceivedDate):''):'Not recorded';
 return '<tr><td><strong>'+dateText(e.when)+'</strong><span class="status">'+esc(label)+'</span></td>'+
  '<td class="wrap"><strong>'+esc(p.siteName||p.address||"Residential scheme")+'</strong><small>'+esc(p.address||"")+'</small></td>'+
  '<td class="wrap">'+esc(p.applicant||"Not verified")+(p.companyGroup?'<small>Group: '+esc(p.companyGroup)+'</small>':'')+'</td>'+
  '<td>'+esc(p.authority||"")+'<small>'+fmt(p.units)+' homes</small></td>'+
  '<td>'+dateText(p.received)+'</td><td>'+esc(fi)+'<small>Due: '+dateText(p.decisionDueDate)+'</small></td>'+
  '<td>'+esc(p.decision||"Pending / not recorded")+'<small>Grant: '+dateText(p.councilGrantDate)+' · Final: '+dateText(p.finalGrantDate)+'</small></td>'+
  '<td class="wrap">'+detailMarkup(p)+'</td></tr>';
}
function renderEvents(){
 const name=CATS.find(x=>x[0]===active)?.[1]||"Events";
 $("#eventHeading").textContent=name+" · past 28 days";
 const term=lower($("#eventSearch").value.trim());
 const rows=events.filter(e=>e.status===active&&matchesAuthority(e.p)&&matchesSearch(e.p,term)).sort((a,b)=>dateValue(b.when)-dateValue(a.when));
 $("#eventSummary").textContent=fmt(rows.length)+" matched events. A scheme may appear in more than one category if separate events occurred.";
 $("#eventRows").innerHTML=rows.length?rows.slice(0,eventLimit).map(eventRow).join(""):'<tr><td colspan="8" class="empty">'+(active==="started"?"No verified project-level BCMS matches yet. The source is linked below.":"No matching recorded events in the selected window.")+'</td></tr>';
 $("#eventCount").textContent="Showing "+fmt(Math.min(rows.length,eventLimit))+" of "+fmt(rows.length);
 $("#moreEvents").hidden=rows.length<=eventLimit;
}
function historyRow(p){
 const u=safeUrl(p.source),name=p.siteName||p.address||"Residential scheme";
 return '<tr><td class="wrap"><strong>'+esc(name)+'</strong><small>'+esc(p.reference||"")+'</small></td>'+
  '<td class="wrap">'+esc(p.applicant||"Unverified")+(p.companyGroup?'<small>'+esc(p.companyGroup)+'</small>':'')+'</td>'+
  '<td>'+esc(p.authority||"")+'</td><td>'+fmt(p.units)+'</td><td>'+dateText(p.received)+'</td>'+
  '<td>'+esc(p.decision||"—")+'</td><td>'+dateText(p.finalGrantDate)+'</td><td>'+esc(p.route||p.type||"Residential")+'</td>'+
  '<td>'+(u?'<a href="'+esc(u)+'" target="_blank" rel="noopener noreferrer">Open '+esc(p.reference||"record")+' ↗</a>':'Link unavailable')+'</td></tr>';
}
function historyFiltered(){
 const year=$("#year").value,term=lower($("#historySearch").value.trim());
 return records.filter(p=>matchesAuthority(p)&&(!year||new Date(dateValue(p.received)).getFullYear()===Number(year))&&matchesSearch(p,term))
  .sort((a,b)=>dateValue(b.received)-dateValue(a.received));
}
function renderHistory(){
 const rows=historyFiltered();
 $("#historyRows").innerHTML=rows.length?rows.slice(0,historyLimit).map(historyRow).join(""):'<tr><td colspan="9" class="empty">No matching indexed schemes.</td></tr>';
 $("#historySummary").textContent=fmt(rows.length)+" matching indexed records · "+fmt(Math.min(rows.length,historyLimit))+" shown. Dates may be missing from the source.";
 $("#moreHistory").hidden=rows.length<=historyLimit;
}
function render(){metricRender();drawCharts();renderEvents();renderHistory()}
function csvValue(v){const s=String(v??"");return '"'+(/^[=+\-@\t\r]/.test(s)?"'":"")+s.replace(/"/g,'""')+'"'}
function exportCsv(name,items){
 const columns=["event","eventDate","reference","siteName","address","authority","units","applicant","companyGroup","received","fiRequestDate","fiReceivedDate","decisionDueDate","decision","councilDecisionDate","councilGrantDate","acpLodgedDate","acpDecisionDate","acpOutcome","finalGrantDate","source","projectWebsite"];
 const data=[columns.join(","),...items.map(item=>{const p=item.p||item;return columns.map(c=>csvValue(c==="event"?item.status||"":c==="eventDate"?dateText(item.when):c==="projectWebsite"?projectWebsite(p):/Date$|^received$/.test(c)?dateText(p[c]):p[c])).join(",")})].join("\r\n");
 const blob=new Blob(["\ufeff",data],{type:"text/csv;charset=utf-8"});const url=URL.createObjectURL(blob);
 const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
}
async function fetchJson(url,timeoutMs=19000){
 let error;
 for(let attempt=0;attempt<2;attempt++){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const r=await fetch(url,{signal:controller.signal,cache:"no-store"});
   if(!r.ok)throw Error("HTTP "+r.status);
   const data=await r.json();
   if(data.error)throw Error(data.error.message||"Service query error");
   return data;
  }catch(e){error=e;}finally{clearTimeout(timer)}
 }
 throw error;
}
async function serviceRecent(url,candidates,unitsWhere="1=1"){
 const root=url.replace(/\/query$/,"");
 const meta=await fetchJson(root+"?f=json");
 const known=new Set((meta.fields||[]).map(f=>f.name));
 const dates=candidates.filter(f=>known.has(f));
 if(!dates.length)throw Error("No published date fields");
 const out=new Map(),fail=[];
 const dateLiteral=isoDay(start.getTime())+" 00:00:00";
 for(const field of dates){
  const where="("+unitsWhere+") AND "+field+" >= TIMESTAMP '"+dateLiteral+"'";
  try{
   for(let offset=0;offset<3000;offset+=1000){
    const query=new URLSearchParams({f:"json",where,outFields:"*",returnGeometry:"false",resultOffset:String(offset),resultRecordCount:"1000",orderByFields:field+" DESC"});
    const data=await fetchJson(root+"/query?"+query);
    const rows=data.features||[];
    for(const row of rows){const p=row.attributes||{},id=p.OBJECTID||p.ObjectId||p.FID||p.ApplicationNumber||p.ABPCASEID;out.set(String(id),p);}
    if(rows.length<1000&&!data.exceededTransferLimit)break;
   }
  }catch(e){fail.push(field+": "+e.message)}
 }
 if(!out.size){
  // A source can reject timestamp syntax; a bounded newest-first query
  // still permits client-side classification without inventing dates.
  const order=known.has("ReceivedDate")?"ReceivedDate":known.has("LODGEDON")?"LODGEDON":dates[0];
  const q=new URLSearchParams({f:"json",where:unitsWhere,outFields:"*",returnGeometry:"false",resultRecordCount:"1500",orderByFields:order+" DESC"});
  const data=await fetchJson(root+"/query?"+q);
  for(const row of data.features||[]){const p=row.attributes||{};out.set(String(p.OBJECTID||p.ABPCASEID||p.ApplicationNumber),p);}
  partialErrors.push("Date-filter query was unavailable; showing a bounded recent "+(root===ACP_SOURCE?"ACP":"council")+" sample.");
 }
 if(fail.length&&out.size)partialErrors.push("Some event-date queries unavailable ("+fail.join("; ").slice(0,150)+").");
 return [...out.values()];
}
async function arcgisRecent(){
 return serviceRecent(SOURCE,["ReceivedDate","GrantDate","WithdrawnDate","DecisionDate","AppealSubmittedDate","AppealDecisionDate"],"NumResidentialUnits > 0");
}
function acpUnits(text){
 const matches=String(text||"").replace(/(?<=\d),(?=\d{3}\b)/g,"").matchAll(/\b(\d{2,5})\s*(?:no\.?\s*)?(?:new\s+)?(?:residential\s+)?(?:units|dwellings|homes|houses|apartments)\b/gi);
 let max=0;for(const m of matches)max=Math.max(max,Number(m[1]));return max;
}
async function acpRecent(){
 return serviceRecent(ACP_SOURCE,["LODGEDON","DECISIONDATE","DECIDEDON","DATEDECIDED","FINALDECISIONDATE"],"1=1");
}
function makeAcpRecord(raw,byKey){
 const caseId=String(raw.ABPCASEID||"").match(/\d{6}/)?.[0];
 if(!caseId)return null;
 const indexed=byKey.get("acp|"+caseId);
 const description=String(raw.DEVDESC||"");
 const units=Number(indexed?.units)||acpUnits(description);
 if(units<=100)return null;
 const decisionDate=raw.DECISIONDATE||raw.DECIDEDON||raw.DATEDECIDED||raw.FINALDECISIONDATE||"";
 const applicant=raw.APPLICANTNAME||raw.APPLICANT_NAME||raw.APPLICANT||indexed?.applicant||"";
 const councilRef=indexed?.planningReference||raw.PLANREF||raw.PLANNINGREF||"";
 const source=safeUrl(raw.LINKABPWEB)||"https://www.pleanala.ie/en-ie/case/"+caseId;
 const item={...(indexed||{}),key:"acp|"+caseId,kind:"acp",caseId,reference:caseId,
  authority:indexed?.authority||raw.PLANINGATY||"An Coimisiún Pleanála",
  planningReference:councilRef,
  units,description:description||indexed?.description||"",
  siteName:indexed?.siteName||raw.DEVADDRESS||"ACP residential scheme",
  address:indexed?.address||raw.DEVADDRESS||"",applicant,
  received:raw.LODGEDON||indexed?.received||"",
  acpLodgedDate:raw.LODGEDON||indexed?.acpLodgedDate||"",
  acpDecisionDate:decisionDate||indexed?.acpDecisionDate||"",
  acpOutcome:raw.DECISION||indexed?.acpOutcome||"",
  decision:raw.DECISION||indexed?.decision||"",
  source,isAppeal:Boolean(indexed?.possibleDuplicateOf||councilRef)};
 return applyEdit(item);
}

async function load(){
 if(loading)return;loading=true;
 $("#refresh").disabled=true;$("#feedStatus").textContent="Refreshing 28-day event feed and applicant catalogue…";
 partialErrors=[];
 let live=[],acpLive=[];
 const results=await Promise.allSettled([arcgisRecent(),acpRecent()]);
 if(results[0].status==="fulfilled")live=results[0].value;else partialErrors.push("Live national planning feed unavailable: "+results[0].reason?.message);
 if(results[1].status==="fulfilled")acpLive=results[1].value;else partialErrors.push("Live ACP case feed unavailable: "+results[1].reason?.message);
 try{
  const r=await fetch("../preview-r10/data/major-schemes.json?ts="+Date.now(),{cache:"no-store"});
  if(!r.ok)throw Error("HTTP "+r.status);
  const data=await r.json();
  catalogue=(data.projects||[]).map(normalizeCatalogue);
 }catch(e){partialErrors.push("Indexed scheme catalogue unavailable: "+e.message);catalogue=[]}
 try{
  const r=await fetch("../preview-r10/data/verified-major-cases.json?ts="+Date.now(),{cache:"no-store"});
  if(r.ok){
   const d=await r.json();
   for(const p of catalogue){const proof=d.cases?.[p.key];if(proof?.applicant&&!p.applicant)p.applicant=proof.applicant;if(proof?.planningReference&&!p.planningReference)p.planningReference=proof.planningReference}
  }
 }catch{}
 const catalogMap=new Map(catalogue.filter(p=>p.kind!=="acp").map(p=>[p.key,p]));
 const catalogueAllByKey=new Map(catalogue.map(p=>[p.key,p]));
 const acpMap=new Map(catalogue.filter(p=>p.kind==="acp").map(p=>[clean(p.caseId||p.reference),p]));
 const joined=new Map();
 for(const p of catalogue){if(p.kind==="acp")continue;joined.set(p.key,enrichFromCatalogue(p,catalogMap,acpMap))}
 for(const raw of live){
  const p=makeRecord(raw),old=joined.get(p.key);
  joined.set(p.key,enrichFromCatalogue(old?{...old,...p,applicant:p.applicant||old.applicant,siteName:old.siteName||p.siteName}:p,catalogMap,acpMap));
 }
 // ACP-only applications remain in history, but do not invent 28-day council events.
 const matchedCases=new Set([...joined.values()].filter(p=>p.kind!=="acp").map(p=>clean(p.appealRef).match(/\d{6}/)?.[0]).filter(Boolean));
 for(const p of catalogue.filter(p=>p.kind==="acp")){
  if(p.possibleDuplicateOf&&joined.has(p.possibleDuplicateOf))continue;
  if(matchedCases.has(clean(p.caseId||p.reference).match(/\d{6}/)?.[0]))continue;
  if(!joined.has(p.key))joined.set(p.key,enrichFromCatalogue(p,catalogMap,acpMap));
 }
 for(const raw of acpLive){const p=makeAcpRecord(raw,catalogueAllByKey);if(!p)continue;const old=joined.get(p.key);joined.set(p.key,old?enrichFromCatalogue({...old,...p,applicant:p.applicant||old.applicant},catalogMap,acpMap):enrichFromCatalogue(p,catalogMap,acpMap));}
 for(const [id,edit] of Object.entries(localEdits)){
  if(id.startsWith("manual|")&&edit&&Number(edit.units)>100&&!joined.has(id))joined.set(id,applyEdit({...edit,key:id,kind:"manual"}));
 }
 records=[...joined.values()].filter(p=>Number(p.units)>100);
 events=records.flatMap(classify);
 const auths=[...new Set(records.map(p=>p.authority).filter(Boolean))].sort();
 const previous=$("#authority").value;
 $("#authority").innerHTML='<option value="">All councils</option>'+auths.map(v=>'<option value="'+esc(v)+'">'+esc(v)+'</option>').join("");
 $("#authority").value=previous;
 const years=[...new Set(records.map(p=>new Date(dateValue(p.received)).getFullYear()).filter(y=>y>1990&&y<=today.getFullYear()))].sort((a,b)=>b-a);
 const oldYear=$("#year").value;
 $("#year").innerHTML='<option value="">All years</option>'+years.map(y=>'<option value="'+y+'">'+y+'</option>').join("");
 $("#year").value=oldYear;
 $("#windowText").textContent=dateText(start.getTime())+" – "+dateText(end.getTime()-DAY)+" · "+fmt(live.length)+" council records, "+fmt(acpLive.length)+" ACP cases checked, "+fmt(catalogue.length)+" indexed records";
 $("#feedStatus").textContent=partialErrors.length?partialErrors.join(" · ")+" · Showing available indexed data.":"Live national planning query completed. Categories use recorded event dates, not inferred status changes. Applicant names and websites are enriched only where evidence exists.";
 $("#feedStatus").className="notice"+(partialErrors.length?" error":"");
 loading=false;$("#refresh").disabled=false;render();
}
function init(){
 $("#refresh").onclick=load;
 for(const id of ["authority","minUnits"])$("#"+id).addEventListener("change",render);
 $("#eventSearch").addEventListener("input",()=>{eventLimit=60;renderEvents()});
 $("#historySearch").addEventListener("input",()=>{historyLimit=75;renderHistory()});
 $("#year").addEventListener("change",()=>{historyLimit=75;renderHistory()});
 $("#moreEvents").onclick=()=>{eventLimit+=60;renderEvents()};
 $("#moreHistory").onclick=()=>{historyLimit+=75;renderHistory()};
 $("#eventCsv").onclick=()=>{const term=lower($("#eventSearch").value.trim());exportCsv("radharc-28day-"+active+".csv",events.filter(e=>e.status===active&&matchesAuthority(e.p)&&matchesSearch(e.p,term)))};
 $("#historyCsv").onclick=()=>exportCsv("radharc-scheme-history.csv",historyFiltered());
 window.addEventListener("resize",()=>{clearTimeout(window._chartResize);window._chartResize=setTimeout(drawCharts,150)});
 load();
}
init();
