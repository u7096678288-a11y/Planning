"use strict";
(function installCompletionsLauncher(){
  function install(){
    if(document.querySelector("#completionsButton"))return;
    const actions=document.querySelector(".topbar-actions");
    if(!actions)return;
    const link=document.createElement("a");
    link.id="completionsButton";
    link.className="secondary-button";
    link.href="completions.html";
    link.target="_blank";
    link.rel="noopener noreferrer";
    link.textContent="Completions";
    link.title="Match planning permissions to NBCO commencement and completion records";
    const weekly=document.querySelector("#weeklyUpdateButton");
    if(weekly)weekly.after(link);else actions.append(link);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
  document.addEventListener("radharc:modules-ready",install,{once:true});
})();
