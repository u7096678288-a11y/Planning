"use strict";
(function(){
const menu=document.getElementById("exportMenu"),btn=document.getElementById("exportViewButton"),msg=document.getElementById("exportStatus");
if(!menu||!btn)return;
let busy=false;
const say=s=>msg.textContent=s;
const name=ext=>"radharc-view-"+new Date().toISOString().slice(0,10)+"."+ext;
function save(data,ext,type){
 const blob=data instanceof Blob?data:new Blob([data],{type});
 const url=URL.createObjectURL(blob),a=document.createElement("a");
 a.href=url;a.download=name(ext);document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function library(url,backup,test){
 if(test())return Promise.resolve();
 return new Promise((resolve,reject)=>{
  const s=document.createElement("script");s.src=url;
  s.onload=()=>test()?resolve():reject(Error("Library unavailable"));
  s.onerror=()=>{s.remove();backup?library(backup,null,test).then(resolve,reject):reject(Error("Export library failed to load"));};
  document.head.append(s);
 });
}
btn.onclick=()=>{menu.hidden=!menu.hidden;btn.setAttribute("aria-expanded",String(!menu.hidden));};
document.addEventListener("click",e=>{if(!busy&&!menu.contains(e.target)&&e.target!==btn)menu.hidden=true;});
function view(){
 const b=map.getBounds();
 return {box:geom(),bounds:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()],
 layers:["planningPoints","planningSites","acpCases","corkCityDirect","freehold"].filter(k=>layers[k]&&map.hasLayer(layers[k])),
 where:cutoff(),acp:acpCutoff(),date:new Date().toISOString(),
 housing:document.getElementById("residentialType")?.selectedOptions[0]?.textContent,
 authority:document.getElementById("authorityExplorer")?.value||"All authorities",period:periodLabel()};
}
async function screenshot(ext){
 await library("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js","https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",()=>!!window.html2canvas);
 say("Rendering map and decision legend…");
 const canvas=await html2canvas(document.querySelector(".map-column"),{useCORS:true,allowTaint:false,backgroundColor:"#fff",scale:Math.min(2,devicePixelRatio||1.5)});
 const mime=ext==="png"?"image/png":"image/jpeg";
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error("Map image could not be captured")),mime,.93));
 save(blob,ext==="png"?"png":"jpg",mime);
}
function annotate(f,key){
 const p=f.properties||{};
 const kind=S[key]?.type||"planning";
 const extra=typeof enrichmentFor==="function"?enrichmentFor(p,kind):null;
 const links=typeof recordWebLinks==="function"?recordWebLinks(p,kind):[];
 const official=links.find(l=>/official ACP case|planning application/.test(l.label));
 const project=links.filter(l=>l!==official);
 return {type:"Feature",geometry:f.geometry||null,properties:{...p,
  Applicant:(typeof applicantName==="function"?applicantName(p):"")||extra?.applicant||"",
  ApplicantSource:extra?.applicantSource||(applicantName(p)?links.find(l=>/planning application/i.test(l.label))?.url||"":"") ,ApplicantGroup:typeof applicantGroup==="function"?applicantGroup(applicantName(p)||extra?.applicant):"",Developer:extra?.developer||"",
  DeveloperSource:extra?.developerSource||"",
  ApplicationURL:official?.url||"",ProjectWebsites:project.map(l=>l.url).join(" | "),
  ExportLayer:key,ExportSource:S[key]?.label||key,DecisionFlag:FLAG_LABELS[decisionFlag(p,S[key]?.type==="acp"?"acp":"planning")]}};
}
function feature(f){
 if(f.type==="Feature")return f;
 return L.esri.Util.arcgisToGeoJSON(f);
}
async function sourceRecords(key,v){
 const url=S[key].url,where=key==="acpCases"?v.acp:key==="freehold"?"1=1":v.where;
 say("Counting "+S[key].label+"…");
 const count=(await q(url,{where,returnCountOnly:true,...v.box})).count||0;
 if(count>15000)throw Error(S[key].label+" contains "+count+" records. Zoom in or narrow filters (maximum 15,000 per source).");
 const output=[];
 while(output.length<count){
  say("Fetching "+S[key].label+": "+output.length+" / "+count);
  const params={where,outFields:"*",returnGeometry:true,outSR:4326,resultOffset:output.length,resultRecordCount:Math.min(500,count-output.length),...v.box};
  let features;
  try{
   const data=await q(url,{...params,f:"geojson"});
   if(data.type!=="FeatureCollection")throw Error("GeoJSON unsupported");
   features=data.features||[];
  }catch{
   const data=await q(url,{...params,f:"json"});
   features=(data.features||[]).map(feature);
  }
  if(!features.length)throw Error("Incomplete response from "+S[key].label+". Export cancelled.");
  output.push(...features);
 }
 return output.slice(0,count).map(f=>annotate(f,key));
}
async function spatial(v){
 if(corkLoadStarted&&!corkReady&&!confirm("Cork City direct feed is unavailable. Export the other active layers without it?"))throw Error("Cancelled; Cork City has not synced.");
 const all=[];
 for(const key of v.layers){
  if(key==="corkCityDirect")all.push(...corkFiltered().map(f=>annotate(f,key)));
  else all.push(...await sourceRecords(key,v));
 }
 if(!all.length)throw Error("No records in the current view");
 return {type:"FeatureCollection",name:"Radharc Pleanála spatial export",exportedAt:v.date,
  bbox:v.bounds,crs:{type:"name",properties:{name:"EPSG:4326"}},
  filters:{housing:v.housing,authority:v.authority,period:v.period,layers:v.layers},features:all};
}
function rows(fc){
 const keys=[...new Set(fc.features.flatMap(f=>Object.keys(f.properties||{})))];
 const headers=["Longitude","Latitude","GeometryGeoJSON",...keys];
 const records=fc.features.map(f=>{
  const c=f.geometry?.type==="Point"?f.geometry.coordinates:null;
  const row={Longitude:c?.[0]??"",Latitude:c?.[1]??"",GeometryGeoJSON:JSON.stringify(f.geometry)};
  for(const k of keys){const val=f.properties?.[k];row[k]=val==null?"":typeof val==="object"?JSON.stringify(val):val;}
  return row;
 });
 return {headers,records};
}
function csv(fc){
 const {headers,records}=rows(fc),quote=v=>'"'+String(v??"").replaceAll('"','""')+'"';
 const lines=[headers.map(quote).join(","),...records.map(r=>headers.map(h=>quote(r[h])).join(","))];
 save("\ufeff"+lines.join("\r\n"),"csv","text/csv;charset=utf-8");
}
async function excel(fc){
 await library("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js","https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",()=>!!window.XLSX?.utils);
 const {headers,records}=rows(fc),wb=XLSX.utils.book_new();
 XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(records,{header:headers}),"Spatial records");
 XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([["Export date",fc.exportedAt],["Coordinate system","EPSG:4326"],["Housing",fc.filters.housing],["Authority",fc.filters.authority],["Period",fc.filters.period],["Layers",fc.filters.layers.join(", ")],["Record count",fc.features.length]]),"View details");
 save(XLSX.write(wb,{bookType:"xlsx",type:"array"}),"xlsx","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
function shapeFeature(f){
 const p=f.properties||{};
 return {type:"Feature",geometry:f.geometry,properties:{
 REF:String(p.ApplicationNumber||p.ABPCASEID||p.SP_ID||"").slice(0,200),
 AUTHORITY:String(p.PlanningAuthority||p.PLANINGATY||"").slice(0,200),
 APPLICANT:String(p.Applicant||"").slice(0,200),
 APP_SOURCE:String(p.ApplicantSource||"").slice(0,240),
 APP_GROUP:String(p.ApplicantGroup||"").slice(0,200),
 DEVELOPER:String(p.Developer||"").slice(0,200),
 DEV_SOURCE:String(p.DeveloperSource||"").slice(0,240),
 APP_URL:String(p.ApplicationURL||"").slice(0,240),
 SITE_URL:String(p.ProjectWebsites||"").slice(0,240),
 STATUS:String(p.DecisionFlag||"").slice(0,40),
 DECISION:String(p.Decision||p.DECISION||"").slice(0,200),
 UNITS:Number(p.NumResidentialUnits)||0,
 FLOOR_M2:Number(p.FloorArea)||0,
 SITE_HA:Number(p.AreaofSite)||0,
 SOURCE:String(p.ExportLayer||"").slice(0,30),
 RECEIVED:String(p.ReceivedDate||p.LODGEDON||"").slice(0,35)
 }};
}
async function shapefile(fc){
 await Promise.all([
 library("https://cdn.jsdelivr.net/npm/shp-write@0.3.2/dist/shpwrite.js","https://unpkg.com/shp-write@0.3.2/dist/shpwrite.js",()=>!!window.shpwrite?.zip),
 library("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js","https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js",()=>!!window.JSZip)
 ]);
 const groups={points:[],lines:[],polygons:[]};
 for(const f of fc.features){
  const t=f.geometry?.type;
  if(!t)throw Error("A record has no geometry; use GeoJSON to retain it.");
  const key=/Point$/.test(t)?"points":/LineString$/.test(t)?"lines":/Polygon$/.test(t)?"polygons":null;
  if(!key)throw Error("Unsupported Shapefile geometry: "+t);
  groups[key].push(shapeFeature(f));
 }
 const archive=new JSZip();
 for(const [key,features] of Object.entries(groups)){
  if(!features.length)continue;
  say("Creating "+key+" Shapefile: "+features.length+" records…");
  const zipped=await Promise.resolve(shpwrite.zip({type:"FeatureCollection",features},{folder:key,types:{point:"points",polyline:"lines",polygon:"polygons"}}));
  if(typeof zipped==="string")archive.file(key+".zip",zipped,{base64:true});
  else if(zipped instanceof Blob||zipped instanceof ArrayBuffer||ArrayBuffer.isView(zipped))archive.file(key+".zip",zipped);
  else throw Error("Shapefile ZIP output was not recognised.");
 }
 archive.file("README.txt","Radharc Pleanála spatial export\nCRS: EPSG:4326 (WGS84)\nSeparate shapefiles are supplied by geometry type.\nExport date: "+fc.exportedAt+"\n");
 save(await archive.generateAsync({type:"blob",compression:"DEFLATE"}),"zip","application/zip");
}
async function run(type){
 if(busy)return;busy=true;
 const options=[...menu.querySelectorAll("[data-export]")];
 options.forEach(b=>b.disabled=true);
 try{
  const v=view();
  if(type==="png"||type==="jpeg")await screenshot(type);
  else{
   const fc=await spatial(v);
   say("Preparing "+type.toUpperCase()+" with "+fc.features.length+" records…");
   if(type==="geojson")save(JSON.stringify(fc,null,2),"geojson","application/geo+json");
   else if(type==="csv")csv(fc);
   else if(type==="xlsx")await excel(fc);
   else if(type==="shp")await shapefile(fc);
  }
  say("Export ready. The file should be in your downloads.");
 }catch(e){
  console.error("Export failed",e);
  say("Export failed: "+(e.message||String(e)));
 }finally{busy=false;options.forEach(b=>b.disabled=false);}
}
menu.querySelectorAll("[data-export]").forEach(b=>b.addEventListener("click",()=>run(b.dataset.export)));
})();
