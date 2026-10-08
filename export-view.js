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
 return {type:"Feature",geometry:f.geometry||null,properties:{...p,ExportLayer:key,ExportSource:S[key]?.label||key,DecisionFlag:FLAG_LABELS[decisionFlag(p,S[key]?.type==="acp"?"acp":"planning")]}};
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
