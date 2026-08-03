"use strict";

(function enhanceSmartFiltersWithSelectAll() {
  const keys = ["decision", "authority", "category"];

  function matchingOptions(key) {
    const refs = smartTools[key];
    if (!refs) return [];
    const query = refs.search.value.trim().toLocaleLowerCase("en-IE");
    return smartOptionData[key].filter(option =>
      !query || option.label.toLocaleLowerCase("en-IE").includes(query)
    );
  }

  function updateSelectAllButton(key) {
    const refs = smartTools[key];
    if (!refs?.selectAll) return;
    const options = matchingOptions(key);
    const selected = new Set(smartState[key]);
    const allSelected = options.length > 0 && options.every(option => selected.has(option.value));
    const hasSearch = refs.search.value.trim().length > 0;

    refs.selectAll.textContent = hasSearch ? "Select shown" : "Select all";
    refs.selectAll.disabled = options.length === 0 || allSelected;
    refs.selectAll.title = hasSearch
      ? "Select every option matching this search"
      : "Select every available option";
  }

  function addSelectAllButton(key) {
    const refs = smartTools[key];
    if (!refs || refs.selectAll) return;

    const button = document.createElement("button");
    button.className = "smart-choice-select-all";
    button.type = "button";
    button.textContent = "Select all";
    refs.clear.before(button);
    refs.selectAll = button;

    button.addEventListener("click", () => {
      const visibleValues = matchingOptions(key).map(option => option.value);
      const combined = [...new Set([...smartState[key], ...visibleValues])];
      smartSetFilter(key, combined);
    });

    refs.search.addEventListener("input", () => updateSelectAllButton(key));
    updateSelectAllButton(key);
  }

  const originalRender = smartRenderFilterTool;
  smartRenderFilterTool = function renderFilterWithSelectAll(key) {
    originalRender(key);
    updateSelectAllButton(key);
  };

  const style = document.createElement("style");
  style.id = "selectAllFilterStyles";
  style.textContent = `
    .smart-choice-select-all{
      border:1px solid #82aaa7;
      border-radius:6px;
      padding:7px 9px;
      background:#e9f5f3;
      color:#174d50;
      font-size:11px;
      font-weight:bold;
      white-space:nowrap
    }
    .smart-choice-select-all:hover:not(:disabled){background:#dcefeb}
    .smart-choice-select-all:disabled{opacity:.42;cursor:not-allowed}
    @media(max-width:700px){
      .smart-choice-toolbar{flex-wrap:wrap}
      .smart-choice-search{flex-basis:100%}
      .smart-choice-select-all,.smart-choice-clear{flex:1}
    }
  `;
  document.head.append(style);

  document.addEventListener("DOMContentLoaded", () => {
    keys.forEach(addSelectAllButton);
  });
})();