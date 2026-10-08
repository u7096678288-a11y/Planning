async function fetchCatalogueFile(name){
 try{const r=await fetch("../preview-r10/data/"+name+"?ts="+Date.now(),{cache:"no-store"});if(r.ok)return r;}catch(error){console.warn("Latest catalogue temporarily unavailable",error);}
 return fetch("data/"+name+"?ts="+Date.now(),{cache:"no-store"});
}
"use strict";
(() => {
const STORAGE="radharc.major-schemes.edits.v1";
const $=id=>document.getElementById(id);
const fields=["applicant","companyGroup","developer","siteName","units","authority","reference","route","tags","received","councilGrantDate","acpLodgedDate","acpDecisionDate","acpOutcome","finalGrantDate","evidenceUrl","notes"];
let source=[],edits={},currentKey="",filtered=[],visible=60,manualCount=0;
const safe=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const validUrl=v=>{try{const u=new URL(v);return ["http:","https:"].includes(u.protocol)&&!u.username&&!u.password?u.href:"";}catch{return""}};
const number=v=>Number.isFinite(+v)?+v:0;
const fmt=v=>Math.round(number(v)).toLocaleString("en-IE");
const date=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||"")?v:"";
const key=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]/g,"");
const cleanGroup=v=>String(v||"").replace(/[.,]/g," ").replace(/\s+/g," ").replace(/\s+(?:ltd|limited|dac|designated activity company)$/i,"").trim();
function loadEdits(){try{const obj=JSON.parse(localStorage.getItem(STORAGE)||"{}");return obj&&typeof obj==="object"&&!Array.isArray(obj)?obj:{}}catch{return{}}}
function saveEdits(){try{localStorage.setItem(STORAGE,JSON.stringify(edits));$("notice").textContent="Saved in this browser";return true}catch(e){$("notice").textContent="Save failed: browser storage unavailable. Export your edits.";return false}}
function routeOf(p){const raw=[p.route,p.type,p.description,p.reference,p.tags].join(" ").toLowerCase();if(p.route)return p.route;if(/\b(?:extension of duration|fep\d+)\b/i.test(raw))return "Extension of duration";if(/\b(?:amendment|modification|alteration)\b/i.test(raw))return "Amendment";if(/\bmixed[\s-]?use\b/i.test(raw))return "Mixed-use";if(/\bshd\b|strategic housing development/i.test(raw))return "SHD";if(/\blrd\b|large.scale residential development/i.test(raw))return "LRD";return "Other"}
function getAll(){
 const all=source.map(p=>{const edited=Object.prototype.hasOwnProperty.call(edits,p.key);const item={...p,...(edited?edits[p.key]:{}),_edited:edited};if(p.kind==="acp"){item.acpLodgedDate=item.acpLodgedDate||p.received||"";item.received=edited?(edits[p.key].received||""):(p.councilLodgedDate||"");}return item;});
 for(const [id,v] of Object.entries(edits))if(id.startsWith("manual|")&&!source.some(p=>p.key===id))all.push({...v,key:id,kind:"manual",_edited:true});
 return all.filter(p=>number(p.units)>100);
}
function finalDate(p,allByKey){
 if(date(p.finalGrantDate))return p.finalGrantDate;
 if(p.acpOutcome==="Granted"&&date(p.acpDecisionDate))return p.acpDecisionDate;
 if(p.kind==="acp"&&p.possibleDuplicateOf){const council=allByKey.get(p.possibleDuplicateOf);if(council&&date(council.finalGrantDate))return council.finalGrantDate;}
 if(p.kind!=="acp"){
  let hasLinkedAppeal=false;
  for(const item of allByKey.values())if(item.kind==="acp"&&item.possibleDuplicateOf===p.key){
   hasLinkedAppeal=true;
   if(item.acpOutcome==="Granted"&&date(item.acpDecisionDate))return item.acpDecisionDate;
  }
  if(p.acpLodgedDate||hasLinkedAppeal)return "";
  if(date(p.councilGrantDate)&&!["refuse","refused","rejected","withdrawn"].some(x=>String(p.decision||"").toLowerCase().includes(x)))return p.councilGrantDate;
 }
 return "";
}
function tagsOf(p){return Array.isArray(p.tags)?p.tags:String(p.tags||"").split(",").map(s=>s.trim()).filter(Boolean)}
function groupOf(p){return cleanGroup(p.companyGroup||p.applicant||"")}
function recordLink(p){const url=validUrl(p.source);return url?'<a href="'+safe(url)+'" target="_blank" rel="noopener noreferrer">'+safe(p.reference||p.caseId||"Open application")+' ↗</a>':safe(p.reference||p.caseId||"—")}
function filterRows(all){
 const q=$("query").value.trim().toLowerCase(),min=Math.max(101,number($("minUnits").value)||101);
 const authority=$("authority").value,status=$("nameStatus").value,route=$("route").value;
 return all.filter(p=>{
  if(number(p.units)<min||authority&&p.authority!==authority)return false;
  if(status==="missing"&&p.applicant||status==="named"&&!p.applicant||status==="edited"&&!p._edited||status==="appealed"&&!(p.kind==="acp"||p.possibleDuplicateOf||p.acpLodgedDate))return false;
  if(route&&routeOf(p)!==route)return false;
  if(q&&!([p.applicant,p.companyGroup,p.developer,p.siteName,p.address,p.authority,p.reference,p.planningReference,p.description,p.route,p.type,tagsOf(p).join(" "),p.notes].join(" ").toLowerCase().includes(q)))return false;
  return true;
 });
}
function render(){
 const all=getAll(),allByKey=new Map(all.map(p=>[p.key,p]));
 filtered=filterRows(all);
 const named=all.filter(p=>p.applicant).length,changed=all.filter(p=>p._edited).length;
 const acp=all.filter(p=>p.kind==="acp").length;
 const totalHomes=all.reduce((n,p)=>n+number(p.units),0);
 $("stats").innerHTML=[
  [fmt(all.length),"Major application records"],
  [fmt(named),"Named applicants"],
  [fmt(all.length-named),"Applicant names missing"],
  [fmt(changed),"Locally edited records"],
  [fmt(acp),"ACP case records"],
  [fmt(totalHomes),"Reported homes*"]
 ].map(([n,label])=>'<div class="stat"><b>'+n+'</b><span>'+label+'</span></div>').join("");
 $("resultCount").textContent=fmt(filtered.length)+" matching records";
 const rows=filtered.slice(0,visible);
 $("records").innerHTML=rows.map(p=>{
  const final=finalDate(p,allByKey),tags=tagsOf(p);
  const applicant=p.applicant?'<strong>'+safe(p.applicant)+'</strong>':'<span class="warning">Not verified</span>';
  const group=p.companyGroup?'<small>Group: '+safe(p.companyGroup)+'</small>':"";
  const linked=p.possibleDuplicateOf?'<span class="tag flag" title="'+safe(p.duplicateReason||"Potential related record")+'">Linked / possible duplicate</span>':"";
  return '<tr><td class="scheme"><strong>'+safe(p.siteName||p.address||"Unnamed scheme")+'</strong><small>'+safe(p.address||"")+'</small></td>'+
   '<td class="name">'+applicant+' '+group+'</td><td>'+safe(p.authority||"—")+'</td><td>'+fmt(p.units)+'</td>'+
   '<td>'+safe(routeOf(p))+'<div>'+tags.map(t=>'<span class="tag">'+safe(t)+'</span>').join("")+linked+'</div></td>'+
   '<td>'+safe(p.received||"—")+'</td><td>'+safe(p.councilGrantDate||"—")+'</td><td>'+safe(p.acpLodgedDate||"—")+'</td><td>'+safe(p.acpDecisionDate||"—")+'</td><td>'+safe(final||"—")+'</td>'+
   '<td>'+recordLink(p)+'</td><td><button class="btn" data-edit="'+safe(p.key)+'">Edit</button></td></tr>';
 }).join("")||'<tr><td colspan="12">No records match these filters.</td></tr>';
 $("showMore").hidden=filtered.length<=visible;
 $("shownCount").textContent="Showing "+fmt(rows.length)+" of "+fmt(filtered.length);
 $("records").querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>openEdit(b.dataset.edit));
 renderLeaders(all,allByKey);
 renderTimeline(all,allByKey);
}
function renderLeaders(all,allByKey){
 const groups=new Map(),councils=new Map();
 for(const p of all){
  const name=groupOf(p);if(!name)continue;
  const id=key(name);
  if(!groups.has(id))groups.set(id,{name,projects:[],homes:0});
  const g=groups.get(id);g.projects.push(p);g.homes+=number(p.units);
  const ck=id+"|"+key(p.authority);
  if(!councils.has(ck))councils.set(ck,{name,council:p.authority||"Unspecified",projects:[],homes:0});
  const c=councils.get(ck);c.projects.push(p);c.homes+=number(p.units);
 }
 const ranked=[...groups.values()].sort((a,b)=>b.projects.length-a.projects.length||b.homes-a.homes);
 $("leaders").innerHTML=ranked.slice(0,30).map(g=>'<tr><td><details class="details"><summary>'+safe(g.name)+'</summary>'+
 g.projects.slice(0,120).map(p=>'<p>'+safe(p.siteName||p.address||p.reference)+' · '+safe(p.authority)+' · '+recordLink(p)+' · '+fmt(p.units)+' homes</p>').join("")+'</details></td><td>'+fmt(g.projects.length)+'</td><td>'+fmt(g.homes)+'</td></tr>').join("")||'<tr><td colspan="3">No applicants named yet</td></tr>';
 $("councilLeaders").innerHTML=[...councils.values()].sort((a,b)=>b.projects.length-a.projects.length||b.homes-a.homes).slice(0,40).map(g=>'<tr><td>'+safe(g.name)+'<br><small>'+safe(g.council)+'</small></td><td>'+fmt(g.projects.length)+'</td><td>'+fmt(g.homes)+'</td></tr>').join("")||'<tr><td colspan="3">No groups available</td></tr>';
}
function renderTimeline(all,byKey){
 const councils=new Map(),months=new Map();
 for(const p of all){
  const council=p.authority||"Unspecified";
  if(!councils.has(council))councils.set(council,{name:council,total:0,lodged:0,grant:0,acpLodged:0,acp:0,final:0});
  const c=councils.get(council);c.total++;
  if(date(p.received)){c.lodged++;const m=p.received.slice(0,7);if(!months.has(m))months.set(m,{lodged:0,final:0});months.get(m).lodged++;}
  if(date(p.acpLodgedDate))c.acpLodged++;
  if(date(p.councilGrantDate))c.grant++;
  if(date(p.acpDecisionDate))c.acp++;
  const f=finalDate(p,byKey);
  if(f){c.final++;const m=f.slice(0,7);if(!months.has(m))months.set(m,{lodged:0,final:0});months.get(m).final++;}
 }
 $("timelines").innerHTML=[...councils.values()].sort((a,b)=>b.total-a.total).map(c=>'<tr><td>'+safe(c.name)+'</td><td>'+fmt(c.total)+'</td><td>'+fmt(c.lodged)+'</td><td>'+fmt(c.grant)+'</td><td>'+fmt(c.acp)+'</td><td>'+fmt(c.final)+'</td></tr>').join("");
 $("months").innerHTML=[...months.entries()].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,36).map(([m,v])=>'<tr><td>'+safe(m)+'</td><td>'+fmt(v.lodged)+'</td><td>'+fmt(v.final)+'</td></tr>').join("");
}
function openEdit(id){
 const p=getAll().find(p=>p.key===id);
 if(!p)return;
 currentKey=id;
 $("editTitle").textContent="Edit "+(p.siteName||p.reference||"scheme");
 $("editReference").textContent=(p.reference||"New manual record")+" · "+(p.authority||"")+(p.possibleDuplicateOf?" · Related record flagged":"");
 for(const f of fields){const control=$("editForm").elements.namedItem(f);if(control)control.value=f==="tags"?tagsOf(p).join(", "):String(p[f]??"");}
 $("resetEdit").hidden=id.startsWith("manual|");
 $("editDialog").showModal();
}
function saveRecord(){
 const form=$("editForm"),v={};
 for(const f of fields){const el=form.elements.namedItem(f);if(el)v[f]=String(el.value||"").trim();}
 if(number(v.units)<=100||number(v.units)>20000){$("notice").textContent="Only schemes with more than 100 homes are included.";return false;}
 if(!v.authority){$("notice").textContent="A planning authority is required.";return false;}
 if(v.evidenceUrl&&!validUrl(v.evidenceUrl)){$("notice").textContent="Evidence link must be HTTP(S).";return false;}
 v.units=Number(v.units);v.tags=v.tags.split(",").map(s=>s.trim()).filter(Boolean).slice(0,30);
 v.editedAt=new Date().toISOString();v.editSource="Manual browser edit";
 if(currentKey.startsWith("manual|"))v.kind="manual";
 edits[currentKey]=v;
 if(!saveEdits())return false;
 render();return true;
}
function addRecord(){
 const id="manual|"+Date.now()+"-"+(++manualCount);
 edits[id]={key:id,kind:"manual",units:101,authority:"",reference:"",siteName:"",applicant:"",received:""};
 currentKey=id;
 $("editTitle").textContent="Add major residential scheme";
 $("editReference").textContent="Manual record · more than 100 homes";
 for(const f of fields){const control=$("editForm").elements.namedItem(f);if(control)control.value=f==="units"?"101":"";}
 $("resetEdit").hidden=true;
 $("editDialog").showModal();
}
function download(name,text,type){
 const blob=new Blob([text],{type});const url=URL.createObjectURL(blob);
 const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
}
function csvValue(v){let s=String(v??"");if(/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"'}
function exportCsv(){
 const byKey=new Map(getAll().map(p=>[p.key,p]));
 const cols=["key","reference","kind","siteName","address","authority","units","applicant","companyGroup","developer","route","tags","received","councilGrantDate","acpLodgedDate","acpDecisionDate","acpOutcome","finalGrantDate","decision","possibleDuplicateOf","source","evidenceUrl","notes"];
 const lines=[cols.join(",")];
 for(const p of filtered){lines.push(cols.map(c=>csvValue(c==="finalGrantDate"?finalDate(p,byKey):c==="tags"?tagsOf(p).join("; "):p[c])).join(","));}
 download("radharc-major-schemes-"+new Date().toISOString().slice(0,10)+".csv","\uFEFF"+lines.join("\r\n"),"text/csv;charset=utf-8");
}
function exportJson(){
 const payload={schemaVersion:1,format:"radharc-major-scheme-edits",exportedAt:new Date().toISOString(),edits};
 download("radharc-applicant-edits-"+new Date().toISOString().slice(0,10)+".json",JSON.stringify(payload,null,2),"application/json");
}
async function importJson(file){
 try{
  if(file.size>5_000_000)throw Error("Backup exceeds 5 MB");
  const d=JSON.parse(await file.text());
  if(d.schemaVersion!==1||d.format!=="radharc-major-scheme-edits"||!d.edits||typeof d.edits!=="object"||Array.isArray(d.edits))throw Error("Not a Radharc edits backup");
  const incoming=Object.entries(d.edits);
  if(incoming.length>15000)throw Error("Too many edits");
  for(const [id,v] of incoming){
   if(!id||id==="__proto__"||!v||typeof v!=="object"||Array.isArray(v))continue;
   const cleaned={};
   for(const f of fields){if(Object.prototype.hasOwnProperty.call(v,f))cleaned[f]=f==="units"?number(v[f]):f==="tags"?Array.isArray(v[f])?v[f].slice(0,30).map(x=>String(x).slice(0,60)):[]:String(v[f]??"").slice(0,1600);}
   cleaned.editedAt=String(v.editedAt||new Date().toISOString()).slice(0,40);
   cleaned.editSource="Imported manual edit";
   if(id.startsWith("manual|"))cleaned.kind="manual";
   edits[id]=cleaned;
  }
  saveEdits();render();$("notice").textContent="Imported "+incoming.length+" saved edits";
 }catch(e){$("notice").textContent="Import failed: "+e.message}
}
async function init(){
 edits=loadEdits();
 try{
  let r=await fetchCatalogueFile("major-schemes.json");
  if(!r.ok)throw Error("HTTP "+r.status);
  let d=await r.json();
  if(!Array.isArray(d.projects)||d.schemaVersion!==1)throw Error("Invalid catalogue");
  source=d.projects;
  try{
   const vr=await fetchCatalogueFile("verified-major-cases.json");
   if(vr.ok){const vd=await vr.json();for(const p of source){const proof=vd.cases?.[p.key];if(proof?.applicant&&!p.applicant){p.applicant=proof.applicant;p.applicantSource=proof.applicantSource||"";}if(proof?.planningReference&&!p.planningReference)p.planningReference=proof.planningReference;}}
  }catch{}
  $("notice").textContent="Catalogue loaded · "+source.length+" records";
 }catch(e){$("notice").textContent="Catalogue unavailable: "+e.message+". Local manual entries remain accessible."}
 const authorities=[...new Set(getAll().map(p=>p.authority).filter(Boolean))].sort();
 $("authority").innerHTML='<option value="">All authorities</option>'+authorities.map(x=>'<option value="'+safe(x)+'">'+safe(x)+'</option>').join("");
 for(const id of ["query","minUnits","authority","nameStatus","route"])$(id).addEventListener(id==="query"||id==="minUnits"?"input":"change",()=>{visible=60;render()});
 $("showMore").onclick=()=>{visible+=60;render()};
 $("addRecord").onclick=addRecord;
 $("cancelEdit").onclick=()=>{if(currentKey.startsWith("manual|")&&!edits[currentKey]?.editedAt)delete edits[currentKey];$("editDialog").close()};
 $("editForm").addEventListener("submit",e=>{e.preventDefault();if(saveRecord())$("editDialog").close()});
 $("resetEdit").onclick=()=>{if(!confirm("Clear your local changes for this record?"))return;delete edits[currentKey];saveEdits();$("editDialog").close();render()};
 $("exportCsv").onclick=exportCsv;$("exportJson").onclick=exportJson;
 $("importButton").onclick=()=>$("importFile").click();
 $("importFile").onchange=e=>{if(e.target.files?.[0])importJson(e.target.files[0]);e.target.value=""};
 render();
}
init();
})();