"use strict";

(function installWeeklyUpdateLauncher() {
  function install() {
    if (document.querySelector("#weeklyUpdateButton")) return;
    const actions = document.querySelector(".topbar-actions");
    if (!actions) return;
    const link = document.createElement("a");
    link.id = "weeklyUpdateButton";
    link.className = "secondary-button";
    link.href = "weekly-update.html";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Weekly update";
    link.title = "Open the 28-day update for 90+ unit schemes, student housing and significant infrastructure";
    const performance = document.querySelector("#performanceButton");
    if (performance) performance.after(link);
    else document.querySelector("#shareViewButton")?.after(link) || actions.append(link);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
  else install();

  document.addEventListener("radharc:modules-ready", install, { once: true });
})();
