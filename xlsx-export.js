"use strict";

(function installExcelExport(){
  const T=window.RadharcTools=window.RadharcTools||{};
  const MAX_ROWS_PER_LAYER=100000;
  const BATCH_SIZE=400;
  const SOURCE_CONFIG={
    planningPoints:{sheet:"Planning points",where:()=>smartPlanningWhere(),dateFields:["ReceivedDate"],label:"Planning application points"},
    planningSites:{sheet:"Planning sites",where:()=>smartPlanningWhere(),dateFields:["ReceivedDate"],label:"Planning application sites"},
    acpCases:{sheet:"ACP cases",where:()=>smartAcpWhere(),dateFields:["LODGEDON","DECISIONDATE"],label:"ACP cases"},
    freehold:{sheet:"Freehold parcels",where:()=>"1=1",dateFields:[],label:"Freehold cadastral parcels"}
  };

  function selectedLayerKeys(){
    const inputs=[...document.querySelectorAll('#layerToggles input[data-k]')];
    return inputs.length?inputs.filter(input=>input.checked&&!input.disabled).map(input=>input.dataset.k):Object.keys(layers).filter(key=>map.hasLayer(layers[key]));
  }
  function loadSheetJs(){
    if(window.XLSX)return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const existing=document.querySelector("#sheetJsLibrary");
      if(existing){existing.addEventListener("load",resolve,{once:true});existing.addEventListener("error",reject,{once:true});return;}
      const script=document.createElement("script");script.id="sheetJsLibrary";script.src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";script.async=true;
      script.onload=resolve;script.onerror=()=>reject(new Error("Excel library could not be loaded"));document.head.append(script);
    });
  }
  async function postQuery(url,parameters={}){
    const body=new URLSearchParams();
    Object.entries({f:"json",cacheHint:"true",...parameters}).forEach(([key,value])=>{if(value!=null)body.set(key,typeof value==="object"?JSON.stringify(value):String(value));});
    const response=await fetch(`${url}/query`,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"},body,cache:"no-store",credentials:"omit"});
    if(!response.ok)throw new Error(`ArcGIS HTTP ${response.status}`);
    const data=await response.json();if(data.error)throw new Error(data.error.message||"ArcGIS query failed");return data;
  }
  function geometryParameters(){
    const g=geom();
    return {geometry:g.geometry,geometryType:g.geometryType,inSR:g.inSR,spatialRel:g.spatialRel};
  }
  async function objectIds(key){
    const source=S[key],config=SOURCE_CONFIG[key];
    if(!source||!config)return[];
    if(key==="freehold"&&map.getZoom()<13)return[];
    const result=await postQuery(source.url,{where:config.where(),returnIdsOnly:true,returnGeometry:false,...geometryParameters()});
    return Array.isArray(result.objectIds)?[...new Set(result.objectIds)]:[];
  }
  function chunks(values,size){const out=[];for(let i=0;i<values.length;i+=size)out.push(values.slice(i,i+size));return out;}
  async function rowsForLayer(key,ids,onProgress){
    if(!ids.length)return[];
    const batches=chunks(ids,BATCH_SIZE),rows=[];
    for(let index=0;index<batches.length;index+=1){
      const data=await postQuery(S[key].url,{where:"1=1",objectIds:batches[index].join(","),outFields:"*",returnGeometry:false});
      rows.push(...(data.features||[]).map(feature=>feature.attributes||{}));onProgress(index+1,batches.length);
    }
    return rows;
  }
  function excelValue(value,field,dateFields){
    if(value==null)return"";
    if(dateFields.includes(field)){
      const d=new Date(Number.isFinite(Number(value))?Number(value):value);if(!Number.isNaN(d.getTime()))return d;
    }
    if(typeof value==="string"&&/^[=+\-@]/.test(value))return `'${value}`;
    return value;
  }
  function orderedRows(rows,config){
    const fields=[...new Set(rows.flatMap(row=>Object.keys(row)))];
    const priority=["OBJECTID","ApplicationNumber","ABPCASEID","ReceivedDate","LODGEDON","PlanningAuthority","PLANINGATY","Decision","DECISION","CATEGORY","NumResidentialUnits","FloorArea","AreaofSite","DevelopmentAddress","DEVADDRESS","DevelopmentDescription","DEVDESC"];
    fields.sort((a,b)=>{const ai=priority.indexOf(a),bi=priority.indexOf(b);if(ai>=0||bi>=0)return(ai<0?999:ai)-(bi<0?999:bi);return a.localeCompare(b);});
    return {fields,data:rows.map(row=>Object.fromEntries(fields.map(field=>[field,excelValue(row[field],field,config.dateFields)])))};
  }
  function styleSheet(sheet,fields,rowCount){
    sheet["!freeze"]={xSplit:0,ySplit:1};
    sheet["!autofilter"]={ref:`A1:${window.XLSX.utils.encode_col(Math.max(0,fields.length-1))}${Math.max(1,rowCount+1)}`};
    sheet["!cols"]=fields.map(field=>({wch:/Description|Address/i.test(field)?38:/Date|LODGEDON|ReceivedDate/i.test(field)?14:/Units|Area|OBJECTID/i.test(field)?14:Math.min(28,Math.max(12,field.length+2))}));
    for(const field of fields){
      if(/Date|LODGEDON|ReceivedDate/i.test(field)){
        const col=window.XLSX.utils.decode_col(window.XLSX.utils.encode_col(fields.indexOf(field)));
        for(let row=2;row<=rowCount+1;row+=1){const cell=sheet[window.XLSX.utils.encode_cell({c:col,r:row-1})];if(cell&&cell.t==="d")cell.z="dd/mm/yyyy";}
      }
    }
  }
  function summaryRows(keys,counts,notes){
    const bounds=map.getBounds();
    return [
      ["Radharc Pleanála research export",""],
      ["Generated",new Date()],
      ["Active filters",smartSummary()],
      ["Map extent",`${bounds.getWest().toFixed(5)}, ${bounds.getSouth().toFixed(5)}, ${bounds.getEast().toFixed(5)}, ${bounds.getNorth().toFixed(5)}`],
      ["Selected layers",keys.map(key=>S[key]?.label||key).join(" · ")||"None"],
      [],["Layer","Rows exported"],
      ...keys.map(key=>[SOURCE_CONFIG[key]?.label||key,counts[key]??0]),
      [],["Notes",notes.join(" · ")||"All selected layers exported successfully"]
    ];
  }
  function ensureButton(){
    if(document.querySelector("#exportExcelButton"))return;
    const csv=document.querySelector("#exportViewButton");if(!csv)return;
    const button=document.createElement("button");button.id="exportExcelButton";button.className="secondary-button";button.type="button";button.textContent="Export Excel";csv.after(button);
    button.addEventListener("click",exportWorkbook);
  }
  async function exportWorkbook(){
    const button=document.querySelector("#exportExcelButton");if(!button)return;
    const original=button.textContent;button.disabled=true;button.setAttribute("aria-busy","true");button.textContent="Preparing workbook…";
    try{
      await loadSheetJs();
      const keys=selectedLayerKeys();
      if(!keys.length){T.showMessage?.("Select at least one map layer before exporting.","error");return;}
      const workbook=window.XLSX.utils.book_new(),counts={},notes=[];
      for(let i=0;i<keys.length;i+=1){
        const key=keys[i],config=SOURCE_CONFIG[key];if(!config)continue;
        button.textContent=`Reading ${i+1}/${keys.length}: ${config.sheet}…`;
        let ids=[];
        try{ids=await objectIds(key);}catch(error){notes.push(`${config.label}: ${error.message}`);continue;}
        if(key==="freehold"&&map.getZoom()<13){notes.push("Freehold parcels require zoom level 13 or closer and were not exported.");counts[key]=0;continue;}
        if(ids.length>MAX_ROWS_PER_LAYER){notes.push(`${config.label}: ${ids.length.toLocaleString("en-IE")} records exceeds the per-layer limit; narrow the extent.`);counts[key]=0;continue;}
        const rows=await rowsForLayer(key,ids,(done,total)=>{button.textContent=`${config.sheet}: ${done}/${total}`;});
        counts[key]=rows.length;
        const ordered=orderedRows(rows,config);
        const sheet=window.XLSX.utils.json_to_sheet(ordered.data,{header:ordered.fields});
        styleSheet(sheet,ordered.fields,rows.length);
        window.XLSX.utils.book_append_sheet(workbook,sheet,config.sheet.slice(0,31));
      }
      const summary=window.XLSX.utils.aoa_to_sheet(summaryRows(keys,counts,notes));
      summary["!cols"]=[{wch:28},{wch:90}];summary["!freeze"]={xSplit:0,ySplit:1};
      window.XLSX.utils.book_append_sheet(workbook,summary,"Export summary");
      workbook.SheetNames=["Export summary",...workbook.SheetNames.filter(name=>name!=="Export summary")];
      const filename=`radharc-pleanala-layers-${new Date().toISOString().slice(0,10)}.xlsx`;
      window.XLSX.writeFile(workbook,filename,{compression:true,cellDates:true});
      T.showMessage?.(`Excel workbook exported with ${workbook.SheetNames.length-1} layer sheet${workbook.SheetNames.length===2?"":"s"}.`);
    }catch(error){console.error(error);T.showMessage?.(`Excel export failed: ${error.message||error}`,"error",9000);}
    finally{button.disabled=false;button.removeAttribute("aria-busy");button.textContent=original;}
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ensureButton,{once:true});else ensureButton();
})();