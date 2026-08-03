"use strict";

(function exposeRadharcSourceRegistry() {
  try {
    if (typeof S !== "undefined") window.S = S;
  } catch (error) {
    console.warn("Radharc source registry could not be exposed", error);
  }
})();
