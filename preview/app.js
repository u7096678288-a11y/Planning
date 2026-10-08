"use strict";
const S={
  planningPoints:{label:"Planning application points",url:"https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/0",color:"#1677a5",on:true,type:"planning"},
  planningSites:{label:"Planning application sites",url:"https://services.arcgis.com/NzlPQPKn5QF9v2US/arcgis/rest/services/IrishPlanningApplications/FeatureServer/1",color:"#3f8f55",on:false,type:"planning"},
  acpCases:{label:"ACP cases (2016 onwards)",url:"https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/ArcGIS/rest/services/Cases_2016_Onwards/FeatureServer/3",color:"#cc6b24",on:true,type:"acp"},
  freehold:{label:"Freehold cadastral parcels",url:"https://services-eu1.arcgis.com/FH5XCsx8rYXqnjF5/arcgis/rest/services/Cadastral_Parcels_Freehold/FeatureServer/12",color:"#7856a8",on:false,type:"parcel"}
};
const $=s=>document.querySelector(s);
const fmt=n=>new Intl.NumberFormat("en-IE",{maximumFractionDigits:0}).format(Number(n)||0);
const fmtArea=n=>new Intl.NumberFormat("en-IE",{maximumFractionDigits:2}).format(Number(n)||0);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let map,layers={},charts={},selected=null,timer;
let corkReady=false,corkRecords=[],corkError="",corkLoadStarted=false;

const residentialBase=()=>"(NumResidentialUnits IS NOT NULL AND NumResidentialUnits > 0)";
const housingWhere=()=>{
  const type=$("#residentialType")?.value||"all";
  const rules={
    oneoff:"NumResidentialUnits = 1",
    lrd:"(DevelopmentDescription LIKE '%large residential development%' OR DevelopmentDescription LIKE '%large-scale residential development%' OR DevelopmentDescription LIKE '%LRD%')",
    shd:"(DevelopmentDescription LIKE '%strategic housing development%' OR DevelopmentDescription LIKE '%SHD%')",
    sdz:"(DevelopmentDescription LIKE '%strategic development zone%' OR DevelopmentDescription LIKE '%SDZ%')"
  };
  return rules[type]||residentialBase();
};
const nextDay=v=>new Date(new Date(v+"T00:00:00").getTime()+86400000).toISOString().slice(0,10);
const cutoff=()=>{
  const parts=[residentialBase()];
  const start=$("#customStartDate")?.value,end=$("#customEndDate")?.value;
  if(start)parts.push(`ReceivedDate >= DATE '${start}'`);
  if(end)parts.push(`ReceivedDate < DATE '${nextDay(end)}'`);
  const hw=housingWhere(); if(hw!==residentialBase())parts.push(hw);
  const auth=$("#authorityExplorer")?.value;
  if(auth)parts.push(`PlanningAuthority = '${auth.replaceAll("'","''")}'`);
  if(corkReady)parts.push("(PlanningAuthority IS NULL OR UPPER(PlanningAuthority) NOT LIKE 'CORK CITY%')");
  return parts.map(x=>`(${x})`).join(" AND ");
};
const acpCutoff=()=>{
 const parts=[];
 const start=$("#customStartDate")?.value,end=$("#customEndDate")?.value;
 if(start)parts.push(`LODGEDON >= DATE '${start}'`);
 if(end)parts.push(`LODGEDON < DATE '${nextDay(end)}'`);
 const type=$("#residentialType")?.value||"all";
 const residential="(CATEGORY LIKE '%Housing%' OR CATEGORY LIKE '%LRD%' OR CATEGORY LIKE '%SHD%' OR DEVDESC LIKE '%residential%' OR DEVDESC LIKE '%dwelling%' OR DEVDESC LIKE '%housing%' OR DEVDESC LIKE '%apartments%' OR DEVDESC LIKE '%houses%')";
 const rules={all:residential,oneoff:"(DEVDESC LIKE '%single dwelling%' OR DEVDESC LIKE '%one dwelling%' OR DEVDESC LIKE '%one house%')",lrd:"(CATEGORY LIKE '%LRD%' OR DEVDESC LIKE '%large residential development%' OR DEVDESC LIKE '%large-scale residential development%' OR DEVDESC LIKE '%LRD%')",shd:"(CATEGORY LIKE '%SHD%' OR CATEGORY LIKE '%Strategic Housing%' OR DEVDESC LIKE '%strategic housing development%' OR DEVDESC LIKE '%SHD%')",sdz:"(CATEGORY LIKE '%SDZ%' OR DEVDESC LIKE '%strategic development zone%' OR DEVDESC LIKE '%SDZ%')"};
 parts.push(rules[type]||residential);
 return parts.map(x=>`(${x})`).join(" AND ");
};
const periodLabel=()=>{
 const s=$("#customStartDate")?.value,e=$("#customEndDate")?.value;
 return s||e?`${s||"Start"} to ${e||"today"}`:"All dates";
};

const FLAG_COLORS={refused:"#d74646",pending:"#ec9b24",approved:"#2f9b65",new:"#277ac7",other:"#8b98a7"};
const FLAG_LABELS={refused:"Refused",pending:"Pending decision",approved:"Approved",new:"New application",other:"Other / unclear"};
function decisionFlag(p={},kind="planning"){
 const decision=String(kind==="acp"?(p.DECISION||""):(p.AppealDecision||p.Decision||"")).trim().toLowerCase();
 const application=String(p.ApplicationStatus||"").trim().toLowerCase();
 const text=decision||application;
 if(/\b(refus|rejected|reject|not grant|deny|denied|permission refused|appeal refused)/.test(text))return "refused";
 if(/\b(grant|approv|permitted|permission granted|allow appeal|conditional)/.test(text))return "approved";
 if(/\b(withdraw|invalid|quash|dismiss|annul|split decision|not exempt|declined jurisdiction)/.test(text))return "other";
 if(/\b(pending|await|undecided|under consideration|further information|further consideration|due to be decided|live case|in progress)/.test(text))return "pending";
 if(decision)return "other";
 const received=Number(p.ReceivedDate||p.LODGEDON)||Date.parse(p.ReceivedDate||p.LODGEDON||"");
 const age=Date.now()-received;
 if(Number.isFinite(age)&&age>=0&&age<=30*86400000)return "new";
 return "pending";
}
function flagStyle(feature,kind="planning"){
 const flag=decisionFlag(feature?.properties||{},kind);
 return {color:FLAG_COLORS[flag],fillColor:FLAG_COLORS[flag],weight:2,fillOpacity:.18};
}
function markerStyle(feature,kind="planning"){
 const flag=decisionFlag(feature?.properties||{},kind);
 return {radius:5,color:"#ffffff",weight:1.2,fillColor:FLAG_COLORS[flag],fillOpacity:.95};
}

const CORK_RESOURCE="8d5bbfa9-3b0c-40ac-8630-4243bed94b2d";
const CORK_API="https://data.corkcity.ie/api/3/action/datastore_search_sql";
function corkCoords(row){
 const x=Number(row.Longitude),y=Number(row.Latitude);
 if(!Number.isFinite(x)||!Number.isFinite(y))return null;
 const valid=c=>c&&c[0]>=-8.95&&c[0]<=-8.05&&c[1]>=51.65&&c[1]<=52.15;
 for(const c of [[x,y],[y,x],[-Math.abs(x),y]])if(valid(c))return c;
 if(typeof window.proj4==="function"){
  window.proj4.defs("EPSG:2157","+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=0.99982 +x_0=600000 +y_0=750000 +ellps=GRS80 +units=m +no_defs");
  window.proj4.defs("EPSG:29903","+proj=tmerc +lat_0=53.5 +lon_0=-8 +k=1.000035 +x_0=200000 +y_0=250000 +a=6377340.189 +b=6356034.447938534 +towgs84=482.530,-130.596,564.557,-1.042,-0.214,-0.631,8.15 +units=m +no_defs");
  for(const sr of ["EPSG:2157","EPSG:29903"]){
   for(const pair of [[x,y],[y,x]]){
    try{const c=window.proj4(sr,"EPSG:4326",pair);if(valid(c))return c;}catch{}
   }
  }
 }
 return null;
}
function corkSql(sql){
 return new Promise((resolve,reject)=>{
  const cb="__radharcCork"+Date.now()+Math.random().toString(36).slice(2);
  const script=document.createElement("script");const u=new URL(CORK_API);
  u.searchParams.set("sql",sql);u.searchParams.set("callback",cb);
  const cleanup=()=>{clearTimeout(timeout);script.remove();delete window[cb];};
  const timeout=setTimeout(()=>{cleanup();reject(Error("Cork City data request timed out"));},18000);
  window[cb]=response=>{cleanup();if(!response?.success)reject(Error(response?.error?.message||"Cork City data service error"));else resolve(response.result?.records||[]);};
  script.onerror=()=>{cleanup();reject(Error("Cork City data service unreachable"));};
  script.src=u.toString();document.head.append(script);
 });
}
function corkFeature(row){
 const coords=corkCoords(row);if(!coords)return null;
 const p={...row,ApplicationNumber:String(row.ApplicationNumber??""),PlanningAuthority:"Cork City Council",NumResidentialUnits:Number(row.NumResidentialUnits)||0,FloorArea:Number(row.FloorArea)||0,AreaofSite:Number(row.AreaOfSite)||0,DirectSource:"Cork City Council open data"};
 return {type:"Feature",geometry:{type:"Point",coordinates:coords},properties:p};
}
function corkFiltered(){
 if(!corkReady)return [];
 const b=map.getBounds(),auth=$("#authorityExplorer")?.value||"",type=$("#residentialType")?.value||"all";
 if(auth&&!auth.toLowerCase().includes("cork city"))return [];
 const start=$("#customStartDate")?.value,end=$("#customEndDate")?.value;
 return corkRecords.filter(f=>{
  const p=f.properties,coords=f.geometry.coordinates;
  if(!b.contains([coords[1],coords[0]]))return false;
  const d=Date.parse(p.ReceivedDate||"");
  if(start&&(!Number.isFinite(d)||d<Date.parse(start)))return false;
  if(end&&(!Number.isFinite(d)||d>=Date.parse(nextDay(end))))return false;
  if(type==="oneoff")return Number(p.NumResidentialUnits)===1;
  if(["lrd","shd","sdz"].includes(type)){
   const desc=String(p.DevelopmentDescription||"").toLowerCase();
   return type==="lrd"?/large[- ]scale residential|large residential development|\blrd\b/.test(desc):type==="shd"?/strategic housing development|\bshd\b/.test(desc):/strategic development zone|\bsdz\b/.test(desc);
  }
  return Number(p.NumResidentialUnits)>0;
 });
}
function refreshCorkLayer(){
 if(!corkReady||!layers.corkCityDirect)return;
 const visible=corkFiltered();
 layers.corkCityDirect.clearLayers();
 // Protect mobile browsers at national zoom while preserving complete counts and search.
 layers.corkCityDirect.addData({type:"FeatureCollection",features:visible.slice(0,3500)});
 $("#corkCoverage").textContent=`Cork City Council direct feed · ${fmt(visible.length)} matching records in view${visible.length>3500?" · first 3,500 map markers shown":""}`;
}
async function loadCorkCity(){
 if(corkLoadStarted)return;corkLoadStarted=true;
 $("#corkCoverage").textContent="Loading Cork City Council planning records…";
 try{
  const output=[];const pageSize=2000;let truncated=false;
  for(let offset=0;offset<30000;offset+=pageSize){
   const sql=`SELECT * FROM "${CORK_RESOURCE}" WHERE "NumResidentialUnits" > 0 ORDER BY "ReceivedDate" DESC NULLS LAST LIMIT ${pageSize} OFFSET ${offset}`;
   const page=await corkSql(sql);
   output.push(...page);
   if(page.length<pageSize)break;
   if(offset+pageSize>=30000)truncated=true;
  }
  corkRecords=output.map(corkFeature).filter(Boolean);
  if(!corkRecords.length)throw Error("No usable residential coordinates returned");
  S.corkCityDirect={label:"Cork City Council — direct planning feed",type:"planning",color:"#277ac7",on:true};
  layers.corkCityDirect=L.geoJSON(null,{pointToLayer:(f,ll)=>L.circleMarker(ll,markerStyle(f)),onEachFeature:(f,l)=>l.on("click",e=>select("corkCityDirect",f,e.latlng))}).addTo(map);
  corkReady=true;
  const auth=$("#authorityExplorer");if(auth&&![...auth.options].some(o=>o.value==="Cork City Council")){
   const option=document.createElement("option");option.value="Cork City Council";option.textContent="Cork City Council";auth.append(option);
  }
  layers.planningPoints.setWhere(cutoff());layers.planningSites.setWhere(cutoff());
  refreshCorkLayer();update();
  if(truncated)$("#corkCoverage").textContent+=" · Older records may not be included";
 }catch(error){
  corkError=error.message;console.warn("Cork City direct feed",error);
  $("#corkCoverage").textContent="Cork City direct feed unavailable: "+error.message+" · National planning source remains enabled";
 }
}

function init(){
  map=L.map("map").setView([53.35,-8],7);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{
    maxZoom:19,
    attribution:'&copy; OpenStreetMap contributors'
  }).addTo(map);
  makeLayers();
  toggles();
  bind();
  loadAuthorities();
  loadCorkCity();
  update();
  loadAI();
}

function makeLayers(){
  layers.planningPoints=L.esri.featureLayer({
    url:S.planningPoints.url,
    where:cutoff(),
    pointToLayer:(feature,ll)=>L.circleMarker(ll,markerStyle(feature))
  });
  layers.planningSites=L.esri.featureLayer({
    url:S.planningSites.url,
    where:cutoff(),
    style:feature=>flagStyle(feature)
  });
  layers.acpCases=L.esri.featureLayer({
    url:S.acpCases.url,
    where:acpCutoff(),
    style:feature=>({...flagStyle(feature,"acp"),dashArray:"5 3"})
  });
  layers.freehold=L.esri.featureLayer({
    url:S.freehold.url,
    minZoom:13,
    style:{color:S.freehold.color,weight:1,fillOpacity:.06}
  });
  Object.entries(layers).forEach(([k,l])=>{
    l.on("click",e=>select(k,e.layer.feature,e.latlng));
    l.on("requesterror",e=>console.warn("Map layer request failed",k,e));
    if(S[k].on)l.addTo(map);
  });
  status("Live services connected","ok");
}

function toggles(){
  let c=$("#layerToggles");
  c.innerHTML="";
  Object.entries(S).forEach(([k,s])=>{
    let l=document.createElement("label");
    l.className="layer-toggle";
    l.innerHTML=`<input type="checkbox" data-k="${k}" ${s.on?"checked":""}><i style="background:${s.color}"></i><span>${s.label}</span>`;
    l.querySelector("input").onchange=e=>e.target.checked?layers[k].addTo(map):map.removeLayer(layers[k]);
    c.append(l);
  });
}

function bind(){
  map.on("moveend zoomend",()=>{
    clearTimeout(timer);
    timer=setTimeout(update,350);
  });
  $("#dateRange").onchange=()=>{
    layers.planningPoints.setWhere(cutoff());
    layers.planningSites.setWhere(cutoff());
    layers.acpCases.setWhere(acpCutoff());
    $("#searchStatus").textContent=`Filter changed to ${periodLabel()}. Press Search to list records.`;
    $("#searchResults").innerHTML="";
    update();
  };
  ["#residentialType","#authorityExplorer"].forEach(id=>$(id)?.addEventListener("change",()=>{
    layers.planningPoints.setWhere(cutoff()); layers.planningSites.setWhere(cutoff()); layers.acpCases.setWhere(acpCutoff());
    $("#searchResults").innerHTML=""; updateExplorerSummary(); update();
  }));
  $("#applyCustomDates")?.addEventListener("click",()=>{ layers.planningPoints.setWhere(cutoff());layers.planningSites.setWhere(cutoff());layers.acpCases.setWhere(acpCutoff());$("#customDateStatus").textContent=periodLabel();updateExplorerSummary();update(); });
  $("#clearCustomDates")?.addEventListener("click",()=>{ $("#customStartDate").value="";$("#customEndDate").value="";$("#customDateStatus").textContent="All available dates";layers.planningPoints.setWhere(cutoff());layers.planningSites.setWhere(cutoff());layers.acpCases.setWhere(acpCutoff());updateExplorerSummary();update(); });
  $("#refreshButton").onclick=refreshAll;
  $("#searchForm").onsubmit=search;
  $("#copyBriefButton").onclick=copyBrief;
  $("#shareViewButton").onclick=async()=>{try{await navigator.clipboard.writeText(location.href);status("View link copied","ok")}catch{status("Copy link unavailable","error")}};
  $("#resetDashboardButton").onclick=()=>{
    $("#residentialType").value="all";$("#authorityExplorer").value="";
    $("#customStartDate").value="";$("#customEndDate").value="";
    $("#customDateStatus").textContent="All available dates";
    $("#searchInput").value="";$("#searchResults").innerHTML="";
    layers.planningPoints.setWhere(cutoff());layers.planningSites.setWhere(cutoff());layers.acpCases.setWhere(acpCutoff());
    updateExplorerSummary();update();
  };
  $("#exportViewButton").onclick=()=>{
    const ids=[["Residential applications","planningCount"],["Residential units","unitCount"],["Floor area (m²)","floorAreaCount"],["Site area","siteAreaCount"],["ACP matching cases","acpCount"]];
    const csv=[["Metric","Value"],...ids.map(([name,id])=>[name,$("#"+id).textContent])].map(row=>row.map(v=>JSON.stringify(v)).join(",")).join("\\r\\n");
    const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
    const link=document.createElement("a");link.href=url;link.download="residential-overview.csv";link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
}

async function loadAuthorities(){
  try{
    const data=await q(S.planningPoints.url,{where:residentialBase(),outFields:"PlanningAuthority",returnGeometry:false,returnDistinctValues:true,orderByFields:"PlanningAuthority"});
    const select=$("#authorityExplorer");
    [...new Set((data.features||[]).map(f=>f.attributes.PlanningAuthority).filter(Boolean))].sort().forEach(v=>{const o=document.createElement("option");o.value=v;o.textContent=v;select.append(o);});
  }catch(e){console.warn("Authority list unavailable",e)}
  updateExplorerSummary();
}
function updateExplorerSummary(){
  const type=$("#residentialType"); const auth=$("#authorityExplorer");
  if(!type||!auth)return;
  $("#activeFilterSummary").textContent=`${type.options[type.selectedIndex].text} · ${auth.value||"All authorities"} · ${periodLabel()}`;
}

function status(t,m=""){
  $("#connectionStatus").textContent=t;
  $("#connectionStatus").className=`status-pill ${m}`;
}

function geom(){
  let b=map.getBounds();
  return {
    geometry:JSON.stringify({
      xmin:b.getWest(),ymin:b.getSouth(),xmax:b.getEast(),ymax:b.getNorth(),
      spatialReference:{wkid:4326}
    }),
    geometryType:"esriGeometryEnvelope",
    inSR:4326,
    spatialRel:"esriSpatialRelIntersects"
  };
}

async function q(url,p={}){
  let u=new URL(url+"/query");
  Object.entries({f:"json",cacheHint:false,...p,_ts:Date.now()}).forEach(([k,v])=>u.searchParams.set(k,v));
  let r=await fetch(u,{cache:"no-store",signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error(r.status);
  let j=await r.json();
  if(j.error)throw Error(j.error.message);
  return j;
}

async function layerInfo(url){
  let u=new URL(url);
  u.searchParams.set("f","json");
  u.searchParams.set("_ts",Date.now());
  let r=await fetch(u,{cache:"no-store"});
  if(!r.ok)throw Error(r.status);
  let j=await r.json();
  if(j.error)throw Error(j.error.message);
  return j;
}

async function refreshAll(){
  const button=$("#refreshButton");
  button.disabled=true;
  button.textContent="Refreshing…";
  status("Refreshing live feeds");
  Object.values(layers).forEach(l=>{
    if(typeof l.refresh==="function")l.refresh();
    else if(typeof l.redraw==="function")l.redraw();
  });
  await Promise.allSettled([update(),loadAI()]);
  button.disabled=false;
  button.textContent="Refresh data";
}

async function update(){
 if(corkReady)refreshCorkLayer();
 status("Synchronising live sources");
 $("#dashboardUpdated").textContent="Checking live feeds…";
 const g=geom();
 const stats=[
 {statisticType:"sum",onStatisticField:"NumResidentialUnits",outStatisticFieldName:"totalUnits"},
 {statisticType:"count",onStatisticField:"NumResidentialUnits",outStatisticFieldName:"unitRecords"},
 {statisticType:"sum",onStatisticField:"FloorArea",outStatisticFieldName:"totalFloorArea"},
 {statisticType:"count",onStatisticField:"FloorArea",outStatisticFieldName:"floorRecords"},
 {statisticType:"sum",onStatisticField:"AreaofSite",outStatisticFieldName:"totalSiteArea"},
 {statisticType:"count",onStatisticField:"AreaofSite",outStatisticFieldName:"siteRecords"}];
 const [pc,summary,ac]=await Promise.allSettled([
 q(S.planningPoints.url,{where:cutoff(),returnCountOnly:true,...g}),
 q(S.planningPoints.url,{where:cutoff(),outStatistics:JSON.stringify(stats),returnGeometry:false,...g}),
 q(S.acpCases.url,{where:acpCutoff(),returnCountOnly:true,...g})]);
 const ok=r=>r.status==="fulfilled";
 const cork=corkFiltered(),corkTotals={units:0,floor:0,site:0};
 cork.forEach(f=>{const p=f.properties;corkTotals.units+=Number(p.NumResidentialUnits)||0;corkTotals.floor+=Number(p.FloorArea)||0;corkTotals.site+=Number(p.AreaofSite)||0;});
 $("#planningCount").textContent=ok(pc)?fmt(pc.value.count+cork.length):"—";
 $("#acpCount").textContent=ok(ac)?fmt(ac.value.count):"—";
 $("#acpAvailability").textContent=ok(ac)?fmt(ac.value.count)+" matching ACP cases in map area":"ACP source unavailable; planning results still shown";
 if(ok(summary)){
  const t=summary.value.features?.[0]?.attributes||{};
  $("#unitCount").textContent=fmt((Number(t.totalUnits)||0)+corkTotals.units);
  $("#floorAreaCount").textContent=fmt(Math.round((Number(t.totalFloorArea)||0)+corkTotals.floor));
  $("#siteAreaCount").textContent=fmt(Math.round((Number(t.totalSiteArea)||0)+corkTotals.site));
  $("#unitCoverage").textContent=fmt(t.unitRecords)+" records reporting units";
  $("#floorCoverage").textContent="Rounded · "+fmt(t.floorRecords)+" records";
  $("#siteCoverage").textContent="Rounded · "+fmt(t.siteRecords)+" records";
 }else{
  ["unitCount","floorAreaCount","siteAreaCount"].forEach(id=>$("#"+id).textContent="—");
 }
 const planningOK=ok(pc)&&ok(summary),acpOK=ok(ac);
 $("#sourceFreshness").textContent=[planningOK?"National planning connected":"National planning query failed",acpOK?"ACP connected":"ACP query failed",corkReady?"Cork City direct feed connected":corkError?"Cork City direct feed unavailable":"Cork City loading"].join(" · ");
 $("#dashboardUpdated").textContent="Checked "+new Date().toLocaleTimeString("en-IE",{hour:"2-digit",minute:"2-digit"});
 status(planningOK&&acpOK?"Live sources synchronised":planningOK?"Planning synced · ACP unavailable":acpOK?"ACP synced · planning unavailable":"Live sources unavailable",planningOK?"ok":"error");
 [pc,summary,ac].forEach((r,i)=>{if(!ok(r))console.warn("Query failed",i,r.reason)});
}

function draw(id,features,label,value,type){
  let labels=features.map(f=>f.attributes[label]||"Not stated");
  let data=features.map(f=>f.attributes[value]||0);
  charts[id]?.destroy();
  charts[id]=new Chart(document.getElementById(id),{
    type,
    data:{labels,datasets:[{data}]},
    options:{
      responsive:true,
      maintainAspectRatio:false,
      indexAxis:type==="bar"?"y":"x",
      plugins:{legend:{display:type!=="bar",position:"bottom"}}
    }
  });
}

function select(k,f,ll){
  let p=f.properties||{};
  let planning=S[k].type==="planning";
  let title=planning?(p.ApplicationNumber||"Planning application"):
    (S[k].type==="acp"?(p.ABPCASEID||"ACP case"):(p.SP_ID||"Freehold parcel"));
  let fields=planning?[
    ["Address",p.DevelopmentAddress],
    ["Description",p.DevelopmentDescription],
    ["Authority",p.PlanningAuthority],
    ["Decision flag",FLAG_LABELS[decisionFlag(p,planning?"planning":"acp")]],
    ["Decision",p.Decision],
    ["Received",date(p.ReceivedDate)],
    ["Residential units",p.NumResidentialUnits],
    ["Floor area",p.FloorArea],
    ["Site area",p.AreaofSite]
  ]:S[k].type==="acp"?[
    ["Address",p.DEVADDRESS],
    ["Description",p.DEVDESC],
    ["Authority",p.PLANINGATY],
    ["Decision flag",FLAG_LABELS[decisionFlag(p,"acp")]],
    ["Decision",p.DECISION],
    ["Lodged",date(p.LODGEDON)],
    ["Category",p.CATEGORY]
  ]:[
    ["Parcel ID",p.SP_ID],
    ["Area",p.SHAPE_Area]
  ];
  selected={title,fields};
  let html=`<strong>${esc(title)}</strong><dl>${fields.filter(x=>x[1]!=null&&x[1]!=="").map(x=>`<div><dt>${esc(x[0])}</dt><dd>${esc(x[1])}</dd></div>`).join("")}</dl>`;
  $("#selectedRecord").className="record-card";
  $("#selectedRecord").innerHTML=html;
  $("#copyBriefButton").disabled=false;
  L.popup().setLatLng(ll).setContent(`<b>${esc(title)}</b><br>${esc(fields[0]?.[1]||"")}`).openOn(map);
}

function date(v){
  if(!v)return "";
  let d=new Date(v);
  return isNaN(d)?v:d.toLocaleDateString("en-IE");
}

function dateTime(v){
  let d=new Date(Number(v));
  return isNaN(d)?"unknown":d.toLocaleString("en-IE",{
    day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"
  });
}

function recordDate(item){
  let p=item[1].properties||{};
  const v=p.ReceivedDate||p.LODGEDON||0;
  return Number(v)||Date.parse(v)||0;
}

function resultMarkup(item,i){
  let [k,f]=item,p=f.properties||{},planning=k==="planningPoints";
  let ref=planning?(p.ApplicationNumber||"Planning application"):(p.ABPCASEID||"ACP case");
  let address=planning?p.DevelopmentAddress:p.DEVADDRESS;
  let when=planning?p.ReceivedDate:p.LODGEDON;
  let type=planning?(k==="corkCityDirect"?"Cork City":"Planning"):"ACP";
  type+=" · "+FLAG_LABELS[decisionFlag(p,planning?"planning":"acp")];
  return `<button data-i="${i}"><b>${esc(ref)}</b><span>${esc(type)} · ${esc(date(when))}</span><span>${esc((address||"").slice(0,120))}</span></button>`;
}

async function search(e){
  e.preventDefault();
  let raw=$("#searchInput").value.trim();
  let t=raw.replaceAll("'","''");
  let planningText=`(ApplicationNumber LIKE '%${t}%' OR DevelopmentAddress LIKE '%${t}%' OR DevelopmentDescription LIKE '%${t}%')`;
  let acpText=`(ABPCASEID LIKE '%${t}%' OR DEVADDRESS LIKE '%${t}%' OR DEVDESC LIKE '%${t}%')`;
  let wp=raw?`(${cutoff()}) AND ${planningText}`:cutoff();
  let wa=raw?`(${acpCutoff()}) AND ${acpText}`:acpCutoff();
  $("#searchStatus").textContent=`Searching ${periodLabel()}…`;
  try{
    const [planningResult,acpResult]=await Promise.allSettled([
      q(S.planningPoints.url,{where:wp,outFields:"*",returnGeometry:true,outSR:4326,orderByFields:"ReceivedDate DESC",resultRecordCount:50,f:"geojson"}),
      q(S.acpCases.url,{where:wa,outFields:"*",returnGeometry:true,outSR:4326,orderByFields:"LODGEDON DESC",resultRecordCount:50,f:"geojson"})
    ]);
    if(planningResult.status==="rejected"&&acpResult.status==="rejected")throw Error("Both source searches failed");
    if(acpResult.status==="rejected")console.warn("ACP search failed",acpResult.reason);
    const corkMatches=corkFiltered().filter(f=>{const p=f.properties;return !raw||[p.ApplicationNumber,p.DevelopmentAddress,p.DevelopmentDescription].some(v=>String(v||"").toLowerCase().includes(raw.toLowerCase()));}).slice(0,50);
    let all=[
      ...corkMatches.map(f=>["corkCityDirect",f]),
      ...(planningResult.status==="fulfilled"?(planningResult.value.features||[]):[]).map(f=>["planningPoints",f]),
      ...(acpResult.status==="fulfilled"?(acpResult.value.features||[]):[]).map(f=>["acpCases",f])
    ].sort((x,y)=>recordDate(y)-recordDate(x));
    $("#searchResults").innerHTML=all.length?all.map(resultMarkup).join(""):'<div class="empty-state">No matching records were returned for this period.</div>';
    $("#searchResults").querySelectorAll("button").forEach(bu=>bu.onclick=()=>focus(all[bu.dataset.i]));
    let qualifier=raw?` matching “${raw}”`:"";
    $("#searchStatus").textContent=`${all.length} result${all.length===1?"":"s"}${qualifier} in ${periodLabel()}${all.length===100?" (first 100)":""}${acpResult.status==="rejected"?" · ACP search unavailable":""}.`;
  }catch(e){
    console.error(e);
    $("#searchStatus").textContent="Search could not be completed";
  }
}

function focus([k,f]){
  let layer=L.geoJSON(f),g=layer.getBounds();
  if(g.isValid())map.fitBounds(g.pad(.4),{maxZoom:16});
  let c=g.isValid()?g.getCenter():map.getCenter();
  select(k,f,c);
}

async function copyBrief(){
  let t=[selected.title,...selected.fields.filter(x=>x[1]).map(x=>`${x[0]}: ${x[1]}`)].join("\n");
  await navigator.clipboard.writeText(t);
  $("#copyBriefButton").textContent="Copied";
  setTimeout(()=>$("#copyBriefButton").textContent="Copy record brief",1000);
}

async function loadAI(){
  try{
    let r=await fetch("data/ai-insights.json?"+Date.now(),{cache:"no-store"});
    let d=await r.json();
    if(d.summary)$("#aiInsight").innerHTML=`<h3>${esc(d.headline||"Planning intelligence note")}</h3><p>${esc(d.summary)}</p>`;
  }catch{}
}

addEventListener("DOMContentLoaded",()=>{
  try{
    if(!window.L || !window.L.esri)throw new Error("Mapping library did not load. Check connection or reload.");
    init();
  }catch(error){
    console.error("Residential explorer startup error",error);
    $("#dashboardUpdated").textContent="Unable to start";
    $("#sourceFreshness").textContent="Startup error: "+(error?.message||"Unknown error");
    status("Startup failed","error");
  }
});
