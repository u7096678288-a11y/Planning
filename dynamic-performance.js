"use strict";

(function installDynamicPerformance(){
  const originalQ=q;
  function isEmptyWhere(where){return String(where||"").replace(/[()\s]/g,"")==="1=0";}
  q=async function optimizedQuery(url,parameters={}){
    if(isEmptyWhere(parameters.where)){
      if(parameters.returnCountOnly)return{count:0};
      if(parameters.returnIdsOnly)return{objectIdFieldName:"OBJECTID",objectIds:[]};
      return{features:[]};
    }
    return originalQ(url,parameters);
  };

  let searchTimer=null;
  function bindResearchSearch(){
    const input=document.querySelector("#searchInput");
    const form=document.querySelector("#searchForm");
    if(!input||!form)return;
    input.addEventListener("input",()=>{
      clearTimeout(searchTimer);
      const statusText=document.querySelector("#searchStatus");
      if(statusText)statusText.textContent="Search text ready. Press Enter or Search to query the active filters.";
    });
  }

  function idlePrefetch(){
    const run=()=>{
      const selected=[...document.querySelectorAll('#layerToggles input[data-k]:checked')].map(input=>input.dataset.k);
      selected.forEach(key=>S[key]?.url&&layerInfo(S[key].url).catch(()=>{}));
    };
    if("requestIdleCallback" in window)requestIdleCallback(run,{timeout:2500});else setTimeout(run,1200);
  }

  window.RadharcDashboardState={
    snapshot(){
      const bounds=map.getBounds();
      return{
        summary:smartSummary(),planningWhere:smartPlanningWhere(),acpWhere:smartAcpWhere(),
        bounds:[bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()],
        selectedLayers:[...document.querySelectorAll('#layerToggles input[data-k]:checked')].map(input=>input.dataset.k)
      };
    }
  };

  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",()=>{bindResearchSearch();idlePrefetch();},{once:true});
  else{bindResearchSearch();idlePrefetch();}
})();