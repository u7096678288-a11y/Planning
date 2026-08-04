"use strict";

(function universalBuildingControlNormaliser(root, factory) {
  const base = typeof module === "object" && module.exports
    ? require("./building-control-match-core.js")
    : root.RadharcBuildingControlCore;
  const enhanced = factory(base);
  if (typeof module === "object" && module.exports) module.exports = enhanced;
  else root.RadharcBuildingControlCore = enhanced;
})(typeof globalThis !== "undefined" ? globalThis : this, function enhanceBuildingControlCore(core) {
  if (!core) throw new Error("Building-control matching core did not load");
  if (core.__authorityNormaliserInstalled) return core;

  const ascii = value => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const planningRecord = record => ({
    ...(record || {}),
    PlanningAuthority: ascii(record?.PlanningAuthority)
  });

  const certificateRecord = record => ({
    ...(record || {}),
    LocalAuthority: ascii(record?.LocalAuthority),
    CN_County: ascii(record?.CN_County)
  });

  const commencementRecord = record => {
    const copy = certificateRecord(record);
    if (Array.isArray(record?.__sourceRows)) copy.__sourceRows = record.__sourceRows.map(certificateRecord);
    if (Array.isArray(record?.__certificates)) copy.__certificates = record.__certificates.map(certificateRecord);
    return copy;
  };

  const originalCanonicalAuthority = core.canonicalAuthority.bind(core);
  const originalDedupePlanning = core.dedupePlanning.bind(core);
  const originalConsolidateNbcoRows = core.consolidateNbcoRows.bind(core);
  const originalScoreCandidate = core.scoreCandidate.bind(core);
  const originalMatchCommencements = core.matchCommencements.bind(core);

  core.canonicalAuthority = value => originalCanonicalAuthority(ascii(value));
  core.dedupePlanning = records => originalDedupePlanning((records || []).map(planningRecord));
  core.consolidateNbcoRows = rows => originalConsolidateNbcoRows((rows || []).map(certificateRecord));
  core.scoreCandidate = (planning, commencement) => originalScoreCandidate(
    planningRecord(planning),
    commencementRecord(commencement)
  );
  core.matchCommencements = (planningRows, commencementRows) => originalMatchCommencements(
    (planningRows || []).map(planningRecord),
    (commencementRows || []).map(commencementRecord)
  );

  core.asciiAuthorityText = ascii;
  core.__authorityNormaliserInstalled = true;
  return core;
});
