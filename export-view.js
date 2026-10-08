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
