"use strict";
const $=s=>document.querySelector(s);
const fmt=n=>new Intl.NumberFormat("en-IE").format(Number(n)||0);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const text=s=>String(s??"").trim();
const clean=s=>text(s).toLowerCase().replace(/[^a-z0-9]/g,"");
const today=new Date(), start28=new Date(today.getTime()-28*86400000);
const iso=d=>new Date(d).toISOString().slice(0,10);
const since=iso(start28);
const storageKey="radharc.major-schemes.edits.v1";
const PLANNING="https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0";
const ACP="https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/ArcGIS/rest/services/Cases_2016_Onwards/FeatureServer/3";
const categories=[
 ["submitted","Submitted","Lodged applications"],
 ["fi","Further information","FI requests / responses"],
 ["granted","Granted","Council grants"],
 ["refused","Refused","Council refusals"],
 ["decided","Decided","Other council decisions"],
 ["withdrawn","Withdrawn","Withdrawn cases"],
 ["appeal","Appeal lodged","ACP appeal applications"],
 ["appealGranted","Granted on appeal","Confirmed ACP grant decisions"],
 ["appealDecided","Appeal decided","Other ACP decisions"],
 ["strategic","Strategic infrastructure","SID and strategic cases"],
 ["localAuthority","Local authority","Part 8 / public projects"],
 ["cpo","CPO","Compulsory purchase orders"],
 ["rail","Rail orders","Railway orders"],
 ["upcoming","Upcoming","Recorded future due dates"],
 ["started","Started","Recorded commencements"]
];
let catalogue=[],live=[],overrides={},filterCategory="",shown=80,sourceState=[];
try{overrides=JSON.parse(localStorage.getItem(storageKey)||"{}")||{}}catch{overrides={}}
function date(v){
 if(v==null||v==="")return "";
 if(typeof v==="number"){const n=v<1e11?v*1000:v;const d=new Date(n);return isNaN(+d)?"":d.toISOString().slice(0,10)}
 const str=text(v);
 if(/^\d{4}-\d{2}-\d{2}/.test(str))return str.slice(0,10);
 if(/^\d{2}\/\d{2}\/\d{4}$/.test(str)){const [a,b,c]=str.split("/");return c+"-"+b+"-"+a}
 const d=new Date(str);return isNaN(+d)?"":d.toISOString().slice(0,10);
}
function safeUrl(value){
 try{const u=new URL(text(value));return /^https?:$/.test(u.protocol)&&u.hostname&&!u.username&&!u.password?u.href:""}catch{return ""}
}
function typeOf(p){
 const v=[p.type,p.category,p.description,p.reference].join(" ").toLowerCase();
 if(/rail(?:way)?\s+order/.test(v))return "Rail order";
 if(/\bcpo\b|compulsory purchase/.test(v))return "CPO";
 if(/strategic infrastructure|\bsid\b/.test(v))return "Strategic infrastructure";
 if(/\bpart 8\b|local authority development/.test(v))return "Local authority development";
 if(/extension of duration|\bfep\d*/.test(v))return "Extension of duration";
 if(/amendment|modification|alteration|section 146b/.test(v))return "Amendment";
 if(/mixed[\s-]?use/.test(v))return "Mixed-use";
 if(/large[\s-]?scale residential|\blrd\b/.test(v))return "LRD";
 if(/strategic housing|\bshd\b/.test(v))return "SHD";
 return "Residential development";
}
function siteOf(p){
 if(text(p.siteName))return text(p.siteName);
 const address=text(p.address).replace(/^(?:site|lands?)\s+(?:at|on|in)\s+/i,"");
 const parts=address.split(",").map(x=>x.trim()).filter(Boolean);
 return parts.slice(0,2).join(", ")||text(p.description).slice(0,70)||"Unnamed project";
}
function normalized(p){
 const edit=overrides[p.key]||{};
 const x={...p,...edit};
 x.kind=x.kind||"planning";
 x.units=Number(x.units)||0;
 x.received=date(x.received);
 x.decisionDate=date(x.decisionDate||(/grant|approv|conditional/i.test(x.decision||"")?x.councilGrantDate:""));
 x.appealDecisionDate=date(x.appealDecisionDate||x.acpDecisionDate);
 x.appealDate=date(x.appealDate||x.acpLodgedDate);
 for(const f of ["finalGrantDate","fiDate","dueDate","startedDate"])x[f]=date(x[f]);
 x.siteName=siteOf(x);
 x.type=x.type||typeOf(x);
 x.applicant=text(x.applicant);
 x.website=safeUrl(x.website);
 x.source=safeUrl(x.source);
 x.caseId=text(x.caseId);
 return x;
}
function recordKey(p){
 if(p.kind==="acp")return "acp|"+clean(p.caseId||p.reference);
 return "planning|"+clean(p.authority)+"|"+clean(p.reference);
}
function combine(){
 const by=new Map();
 const manuallyAdded=Object.entries(overrides).filter(([k,v])=>k.startsWith("manual|")&&v&&Number(v.units)>100).map(([key,v])=>({...v,key,kind:"manual"}));
 for(const item of [...catalogue,...live,...manuallyAdded]){
  const p={...item,key:item.key||recordKey(item)};
  if(!p.key)continue;
  const old=by.get(p.key);
  if(!old){by.set(p.key,p);continue}
  const merged={...old};
  for(const [k,v] of Object.entries(p))if(v!==""&&v!=null&&!(k==="applicant"&&old.applicant)&&!(k==="siteName"&&old.siteName))merged[k]=v;
  by.set(p.key,merged);
 }
 return [...by.values()].map(normalized);
}
function eventList(p){
 const events=[];
 const decision=text(p.decision||p.appealDecision).toLowerCase();
 const strategic=/strategic infrastructure|\bsid\b/i.test([p.category,p.type,p.description].join(" "));
 const cpo=/\bcpo\b|compulsory purchase/i.test([p.category,p.type,p.description].join(" "));
 const rail=/rail(?:way)?\s+order/i.test([p.category,p.type,p.description].join(" "));
 const local=/\bpart 8\b|local authority development/i.test([p.category,p.type,p.description].join(" "));
 const push=(cat,day,qualifier)=>{if(day&&(!qualifier||qualifier()))events.push({category:cat,day})};
 push("submitted",p.received);
 push("fi",p.fiDate);
 if(p.kind==="acp"){
  push("appeal",p.appealDate||p.received,()=>!strategic&&!cpo&&!rail&&!local);
  push("appealGranted",p.appealDecisionDate||p.decisionDate,()=>/grant|approv|confirm/.test(decision)&&!/refus|quash/.test(decision));
  push("appealDecided",p.appealDecisionDate||p.decisionDate,()=>!!decision&&!/grant|approv|confirm/.test(decision));
 }else{
  push("granted",p.decisionDate,()=>/grant|conditional|approv/.test(decision)&&!/refus/.test(decision));
  push("refused",p.decisionDate,()=>/refus|reject|deny/.test(decision));
  push("withdrawn",p.decisionDate||p.withdrawnDate,()=>/withdraw/.test(decision));
  push("decided",p.decisionDate,()=>!!decision&&!/grant|conditional|approv|refus|reject|deny|withdraw/.test(decision));
 }
 push("strategic",p.received,()=>strategic);
 push("localAuthority",p.received,()=>local);
 push("cpo",p.received,()=>cpo);
 push("rail",p.received,()=>rail);
 push("upcoming",p.dueDate,()=>p.dueDate>=iso(today));
 push("started",p.startedDate);
 return events;
}
function inWindow(d){return d>=since&&d<=iso(today)}
function inMovementWindow(e){return e.category==="upcoming"?e.day>iso(today)&&e.day<=iso(new Date(today.getTime()+28*86400000)):inWindow(e.day)}
function filterRecords(records){
 const q=text($("#search").value).toLowerCase(),year=$("#year").value,council=$("#council").value,units=Number($("#units").value)||0;
 return records.filter(p=>{
  if(units&&p.units<units&&!/strategic infrastructure|\bcpo\b|compulsory purchase|rail(?:way)?\s+order|\bpart 8\b|local authority development/i.test([p.type,p.category,p.description].join(" ")))return false;
  if(year&&!(p.received||"").startsWith(year))return false;
  if(council&&p.authority!==council)return false;
  if(q&&![p.siteName,p.address,p.applicant,p.developer,p.reference,p.caseId,p.planningReference,p.authority,p.description,p.type,p.tags].some(v=>text(v).toLowerCase().includes(q)))return false;
  if(filterCategory&&!eventList(p).some(e=>e.category===filterCategory&&inMovementWindow(e)))return false;
  return true;
 });
}
function activity(p){
 const events=eventList(p).filter(e=>inMovementWindow(e));
 if(filterCategory)return events.find(e=>e.category===filterCategory)||{category:filterCategory,day:""};
 return events.sort((a,b)=>b.day.localeCompare(a.day))[0]||{category:p.kind==="acp"?"appeal":"submitted",day:p.received};
}
function download(filename,content,type){
 const blob=new Blob([content],{type}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500);
}
function csvEscape(x){const s=String(x??"");return '"'+s.replace(/"/g,'""')+'"'}
function exportRows(kind){
 const records=filterRecords(combine());
 if(kind==="json"){download("radharc-movements-"+iso(today)+".json",JSON.stringify({schemaVersion:1,format:"radharc-major-scheme-edits",exportedAt:new Date().toISOString(),edits:overrides,records},null,2),"application/json");return}
 const keys=["siteName","applicant","type","tags","authority","reference","caseId","units","received","fiDate","decision","decisionDate","finalGrantDate","appealDate","appealDecisionDate","dueDate","startedDate","address","website","source","evidence","possibleDuplicateOf"];
 const csv=[keys.map(csvEscape).join(","),...records.map(p=>keys.map(k=>csvEscape(p[k])).join(","))].join("\r\n");
 download("radharc-movements-"+iso(today)+".csv","\ufeff"+csv,"text/csv;charset=utf-8");
}
function barMarkup(items,max){
 return items.map(([name,n])=>'<div class="barrow"><span title="'+esc(name)+'">'+esc(name)+'</span><div class="track"><div class="fill" style="width:'+Math.max(n?2:0,Math.round(100*n/(max||1)))+'%"></div></div><strong>'+fmt(n)+'</strong></div>').join("");
}
function render(){
 const all=combine(),base=filterRecords(all),recent=base.filter(p=>eventList(p).some(e=>inMovementWindow(e))),cardBase=filterCategory?all.filter(p=>{const prev=filterCategory;filterCategory="";const ok=filterRecords([p]).length>0;filterCategory=prev;return ok}):base;
 const cards=$("#movementCards");
 cards.innerHTML=categories.map(([id,label,hint])=>{
  const n=cardBase.filter(p=>eventList(p).some(e=>e.category===id&&inMovementWindow(e))).length;
  return '<button type="button" class="stat" data-category="'+id+'" aria-pressed="'+(filterCategory===id)+'"><span class="count">'+fmt(n)+'</span><span class="label">'+esc(label)+'</span><span class="hint">'+esc(hint)+'</span></button>';
 }).join("");
 cards.querySelectorAll("button").forEach(b=>b.onclick=()=>{filterCategory=filterCategory===b.dataset.category?"":b.dataset.category;shown=80;render()});
 const counts=categories.map(([id,label])=>[label,cardBase.filter(p=>eventList(p).some(e=>e.category===id&&inMovementWindow(e))).length]).filter(x=>x[1]>0);
 $("#movementBars").innerHTML=counts.length?barMarkup(counts,Math.max(...counts.map(x=>x[1]))):'<p class="note">No qualifying events with a verified date in this selection.</p>';
 const groups=new Map();
 for(const p of base){if(!p.applicant)continue;const k=clean(p.applicant.replace(/\s+(ltd|limited|dac)$/i,""));const v=groups.get(k)||{name:p.applicant,count:0};v.count++;groups.set(k,v)}
 const leaders=[...groups.values()].sort((a,b)=>b.count-a.count).slice(0,8).map(v=>[v.name,v.count]);
 $("#companyBars").innerHTML=leaders.length?barMarkup(leaders,leaders[0][1]):'<p class="note">Applicant names not yet available for this selection.</p>';
 const rows=filterCategory?base.slice().sort((a,b)=>(activity(b).day||"").localeCompare(activity(a).day||"")):base.slice().sort((a,b)=>(activity(b).day||"").localeCompare(activity(a).day||""));
 $("#tableTitle").textContent=filterCategory?(categories.find(x=>x[0]===filterCategory)?.[1]||"Movements")+" · past 28 days":"Searchable planning history";
 $("#tableInfo").textContent=filterCategory?"Only records with a dated event in the past 28 days.":"Lodgement year filters apply to the historical table and 28-day movement counts.";
 $("#resultCount").textContent=fmt(rows.length)+" matching records · "+fmt(recent.length)+" with a dated event in the past 28 days · "+fmt(Object.keys(overrides).length)+" locally edited";
 $("#more").hidden=rows.length<=shown;
 $("#rows").innerHTML=rows.length?rows.slice(0,shown).map((p,i)=>{
  const e=activity(p),label=categories.find(x=>x[0]===e.category)?.[1]||e.category;
  const siteUrl=p.website||p.source;
  const site=siteUrl?'<a href="'+esc(siteUrl)+'" target="_blank" rel="noopener noreferrer">'+esc(p.siteName)+' ↗</a>':esc(p.siteName);
  const ref=p.source?'<a href="'+esc(p.source)+'" target="_blank" rel="noopener noreferrer">'+esc(p.reference)+' ↗</a>':esc(p.reference||"—");
  const acp=p.caseId?(p.kind==="acp"&&p.source?'<a href="'+esc(p.source)+'" target="_blank" rel="noopener noreferrer">'+esc(p.caseId)+' ↗</a>':esc(p.caseId)):"—";
  const dates=[p.decisionDate?"Decision "+p.decisionDate:"",p.finalGrantDate?"Final grant "+p.finalGrantDate:"",p.dueDate?"Due "+p.dueDate:"",p.fiDate?"FI "+p.fiDate:""].filter(Boolean).join(" · ");
  return '<tr><td>#'+(i+1)+'</td><td><strong>'+site+'</strong><small>'+esc(p.type)+(p.tags?' · '+esc(p.tags):'')+'</small><small>'+esc(p.address||"")+'</small></td>'+
   '<td>'+esc(p.applicant||"Not yet verified")+'</td><td><span class="tag '+(e.category==="granted"?"granted":e.category==="refused"?"refused":e.category==="appeal"?"appeal":"pending")+'">'+esc(label)+'</span></td>'+
   '<td>'+esc(e.day||"—")+'</td><td>'+ref+'</td><td>'+acp+'</td><td>'+fmt(p.units||0)+'</td><td>'+esc(p.authority||"—")+'</td>'+
   '<td>'+esc(p.decision||"Pending / not recorded")+'<small>'+esc(dates||"No dated decision supplied")+'</small></td>'+
   '<td><button class="edit" data-edit="'+esc(p.key)+'">Edit</button></td></tr>';
 }).join(""):'<tr><td colspan="11" class="empty">No matching records. Try a different year, unit threshold or category.</td></tr>';
 $("#rows").querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openEdit(b.dataset.edit));
}
function fillFilters(){
 const all=combine(),y=$("#year").value,c=$("#council").value;
 const years=[...new Set(all.map(p=>p.received?.slice(0,4)).filter(Boolean))].sort().reverse();
 const councils=[...new Set(all.map(p=>p.authority).filter(Boolean))].sort();
 $("#year").innerHTML='<option value="">All years</option>'+years.map(v=>'<option value="'+esc(v)+'">'+esc(v)+'</option>').join("");
 $("#council").innerHTML='<option value="">All councils</option>'+councils.map(v=>'<option value="'+esc(v)+'">'+esc(v)+'</option>').join("");
 $("#year").value=years.includes(y)?y:"";$("#council").value=councils.includes(c)?c:"";
}
function openEdit(key){
 const p=combine().find(x=>x.key===key);if(!p)return;
 const f=$("#editForm");f.elements.editKey.value=key;
 $("#editTitle").textContent="Edit "+(p.reference||p.siteName);
 for(const name of ["applicant","siteName","website","type","tags","received","fiDate","decisionDate","finalGrantDate","appealDate","appealDecisionDate","dueDate","startedDate","decision","caseId","evidence"])f.elements[name].value=p[name]||"";
 $("#editDialog").showModal();
}
function saveEdit(){
 const f=$("#editForm"),key=f.elements.editKey.value;
 const update={};
 for(const name of ["applicant","siteName","website","type","tags","received","fiDate","decisionDate","finalGrantDate","appealDate","appealDecisionDate","dueDate","startedDate","decision","caseId","evidence"])update[name]=text(f.elements[name].value);
 if(update.website&&!safeUrl(update.website)){alert("Please enter a valid http(s) website URL.");return}
 if(update.decisionDate&&/grant|approv|conditional/i.test(update.decision))update.councilGrantDate=update.decisionDate;
 if(update.appealDecisionDate)update.acpDecisionDate=update.appealDecisionDate;
 if(update.appealDate)update.acpLodgedDate=update.appealDate;
 overrides[key]={...(overrides[key]||{}),...update,updatedAt:new Date().toISOString()};
 try{localStorage.setItem(storageKey,JSON.stringify(overrides))}catch{alert("Local storage is unavailable. Export your edits to JSON to preserve them.")}
 $("#editDialog").close();render();
}
async function queryArcgis(url,where,limit=1000){
 const result=[];
 for(let offset=0;offset<limit;offset+=500){
  const params=new URLSearchParams({f:"json",where,outFields:"*",returnGeometry:"false",resultOffset:String(offset),resultRecordCount:"500",orderByFields:url===ACP?"LODGEDON DESC":"ReceivedDate DESC"});
  const response=await fetch(url+"/query?"+params,{signal:AbortSignal.timeout(16000)});
  if(!response.ok)throw Error("HTTP "+response.status);
  const json=await response.json();
  if(json.error)throw Error(json.error.message||"ArcGIS query error");
  const rows=json.features||[];result.push(...rows.map(x=>x.attributes||{}));
  if(rows.length<500)break;
 }
 return result;
}
function livePlanning(p){
 const authority=text(p.PlanningAuthority),reference=text(p.ApplicationNumber);
 if(!reference)return null;
 return {key:"planning|"+clean(authority)+"|"+clean(reference),kind:"planning",authority,reference,units:Number(p.NumResidentialUnits)||0,
 address:text(p.DevelopmentAddress),description:text(p.DevelopmentDescription),decision:text(p.AppealDecision||p.Decision),received:date(p.ReceivedDate),
 decisionDate:date(p.DecisionDate||p.DecidedDate),finalGrantDate:date(p.FinalGrantDate),dueDate:date(p.DecisionDueDate||p.DueDate),
 applicant:text(p.ApplicantName||p.Applicant),source:text(p.LinkAppDetails)};
}
function liveAcp(p){
 const ref=text(p.ABPCASEID).match(/\d{6}/)?.[0];if(!ref)return null;
 const desc=text(p.DEVDESC),category=text(p.CATEGORY);
 const type=typeOf({description:desc,category});
 const special=/Strategic infrastructure|CPO|Rail order|Local authority development/.test(type);
 const m=desc.replace(/(?<=\d),(?=\d{3}\b)/g,"").match(/\b(\d{3,5})\s*(?:no\.?\s*)?(?:residential\s+)?(?:units|dwellings|homes|houses|apartments)\b/i);
 const units=m?Number(m[1]):0;
 if(units<=100&&!special)return null;
 return {key:"acp|"+ref,kind:"acp",caseId:ref,reference:ref,authority:text(p.PLANINGATY)||"An Coimisiún Pleanála",
 units,address:text(p.DEVADDRESS),description:desc.slice(0,600),category,type,received:date(p.LODGEDON),decision:text(p.DECISION),
 decisionDate:date(p.DECISIONDATE||p.DECIDEDON),applicant:text(p.APPLICANTNAME||p.APPLICANT),source:safeUrl(p.LINKABPWEB)||"https://www.pleanala.ie/en-ie/case/"+ref};
}
async function loadData(){
 $("#freshness").textContent="Refreshing indexed projects and checking live 28-day sources…";
 sourceState=[];let data;
 for(const path of ["data/major-schemes.json","../preview-r8/data/major-schemes.json"]){
  try{const response=await fetch(path+"?v="+Date.now(),{cache:"no-store"});if(!response.ok)throw Error("HTTP "+response.status);
   const json=await response.json();if(!Array.isArray(json.projects)||!json.projects.length)throw Error("Empty catalogue");
   data=json;sourceState.push("Indexed catalogue: "+json.projects.length+" records");break
  }catch(e){sourceState.push("Catalogue fallback needed: "+e.message)}
 }
 catalogue=data?.projects||[];
 try{
  const response=await fetch("data/verified-major-cases.json",{cache:"no-store"});
  if(response.ok){const verified=await response.json();const map=verified.cases||{};for(const p of catalogue){const e=map[p.key];if(e){for(const k of ["applicant","siteName","developer","website","caseId","decisionDate","finalGrantDate"])if(!p[k]&&e[k])p[k]=e[k]}}}
 }catch{}
 fillFilters();render();
 const q1=queryArcgis(PLANNING,"ReceivedDate >= DATE '"+since+"' AND NumResidentialUnits > 100",1000).then(rows=>{
  const values=rows.map(livePlanning).filter(Boolean);live.push(...values);sourceState.push("Live council lodgements: "+values.length);fillFilters();render();
 }).catch(e=>sourceState.push("Live council query unavailable: "+e.message));
 const q2=queryArcgis(ACP,"LODGEDON >= DATE '"+since+"'",1000).then(rows=>{
  const values=rows.map(liveAcp).filter(Boolean);live.push(...values);sourceState.push("Live ACP cases: "+values.length);fillFilters();render();
 }).catch(e=>sourceState.push("Live ACP query unavailable: "+e.message));
 await Promise.allSettled([q1,q2]);
 $("#freshness").textContent=fmt(combine().length)+" indexed/live records · 28-day window "+since+" to "+iso(today);
 $("#sourceNote").textContent=sourceState.join(" · ")+". FI, final grants, appeals and commencements are counted only when dated source evidence is available. BCMS is not connected as a verified live source. Records without a date do not appear in the corresponding 28-day movement.";
}
function init(){
 for(const id of ["search","year","council","units"])$("#"+id).addEventListener(id==="search"?"input":"change",()=>{shown=80;render()});
 $("#showAll").onclick=()=>{filterCategory="";shown=80;render()};
 $("#more").onclick=()=>{shown+=80;render()};
 $("#refresh").onclick=()=>{live=[];loadData()};
 $("#exportCsv").onclick=()=>exportRows("csv");
 $("#exportJson").onclick=()=>exportRows("json");
 $("#cancelEdit").onclick=()=>$("#editDialog").close();
 $("#editForm").addEventListener("submit",e=>{e.preventDefault();saveEdit()});
 $("#importButton").onclick=()=>$("#importFile").click();
 $("#importFile").addEventListener("change",async e=>{
  const f=e.target.files?.[0];if(!f)return;
  try{
   const d=JSON.parse(await f.text()),edits=d.edits||d.manualEdits||d;
   if(!edits||Array.isArray(edits)||typeof edits!=="object")throw Error("Not an edit backup");
   if(!confirm("Import "+Object.keys(edits).length+" manual record edits into this browser? Existing edits with the same key will be replaced."))return;
   overrides={...overrides,...edits};localStorage.setItem(storageKey,JSON.stringify(overrides));render();
  }catch(error){alert("Could not import edit file: "+error.message)}
  e.target.value="";
 });
 loadData();
}
document.addEventListener("DOMContentLoaded",init);
