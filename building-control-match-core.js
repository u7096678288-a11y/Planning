"use strict";

(function universalBuildingControlCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RadharcBuildingControlCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createBuildingControlCore() {
  const text = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const number = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : 0;

  function canonicalAuthority(value) {
    const authority = text(value).toUpperCase()
      .replace(/&/g, " AND ")
      .replace(/[^A-Z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const aliases = [
      ["DUBLIN CITY", "DUBLIN CITY COUNCIL"],
      ["CORK CITY", "CORK CITY COUNCIL"],
      ["CORK COUNTY", "CORK COUNTY COUNCIL"],
      ["DUN LAOGHAIRE RATHDOWN", "DUN LAOGHAIRE RATHDOWN COUNTY COUNCIL"],
      ["FINGAL", "FINGAL COUNTY COUNCIL"],
      ["SOUTH DUBLIN", "SOUTH DUBLIN COUNTY COUNCIL"],
      ["GALWAY CITY", "GALWAY CITY COUNCIL"],
      ["GALWAY COUNTY", "GALWAY COUNTY COUNCIL"],
      ["LIMERICK", "LIMERICK CITY AND COUNTY COUNCIL"],
      ["WATERFORD", "WATERFORD CITY AND COUNTY COUNCIL"],
      ["KILKENNY", "KILKENNY COUNTY COUNCIL"],
      ["KILDARE", "KILDARE COUNTY COUNCIL"],
      ["MEATH", "MEATH COUNTY COUNCIL"],
      ["WICKLOW", "WICKLOW COUNTY COUNCIL"],
      ["LOUTH", "LOUTH COUNTY COUNCIL"],
      ["WESTMEATH", "WESTMEATH COUNTY COUNCIL"],
      ["WEXFORD", "WEXFORD COUNTY COUNCIL"],
      ["CLARE", "CLARE COUNTY COUNCIL"],
      ["DONEGAL", "DONEGAL COUNTY COUNCIL"],
      ["MAYO", "MAYO COUNTY COUNCIL"],
      ["SLIGO", "SLIGO COUNTY COUNCIL"],
      ["LEITRIM", "LEITRIM COUNTY COUNCIL"],
      ["ROSCOMMON", "ROSCOMMON COUNTY COUNCIL"],
      ["CAVAN", "CAVAN COUNTY COUNCIL"],
      ["MONAGHAN", "MONAGHAN COUNTY COUNCIL"],
      ["OFFALY", "OFFALY COUNTY COUNCIL"],
      ["LAOIS", "LAOIS COUNTY COUNCIL"],
      ["LONGFORD", "LONGFORD COUNTY COUNCIL"],
      ["TIPPERARY", "TIPPERARY COUNTY COUNCIL"],
      ["KERRY", "KERRY COUNTY COUNCIL"],
      ["CARLOW", "CARLOW COUNTY COUNCIL"]
    ];
    for (const [match, canonical] of aliases) if (authority.includes(match)) return canonical;
    return authority;
  }

  function normaliseReference(value) {
    return text(value).toUpperCase()
      .replace(/\b(PLANNING|PERMISSION|REFERENCE|REF|APPLICATION|APP|NO|NUMBER)\b/g, "")
      .replace(/[^A-Z0-9]/g, "");
  }

  function referenceTokens(value) {
    const raw = text(value).toUpperCase();
    const tokens = new Set();
    const full = normaliseReference(raw);
    if (full.length >= 4) tokens.add(full);
    (raw.match(/[A-Z]{0,8}[0-9][A-Z0-9\/\-.]{3,}/g) || []).forEach(candidate => {
      const token = normaliseReference(candidate);
      if (token.length >= 4) tokens.add(token);
    });
    (raw.match(/\d{6}/g) || []).forEach(token => tokens.add(token));
    return [...tokens];
  }

  function acpReference(value) {
    const matches = text(value).match(/\d{6}/g);
    return matches?.at(-1) || "";
  }

  function normaliseAddress(value) {
    return text(value).toUpperCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\b(ROAD|RD)\b/g, "RD")
      .replace(/\b(STREET|ST)\b/g, "ST")
      .replace(/\b(AVENUE|AVE)\b/g, "AVE")
      .replace(/\b(BOULEVARD|BLVD)\b/g, "BLVD")
      .replace(/\b(COUNTY|CO)\b/g, "CO")
      .replace(/\b(APARTMENTS?|APTS?)\b/g, "APT")
      .replace(/[^A-Z0-9 ]/g, " ")
      .replace(/\b(THE|AT|AND|OF|IRELAND|PROPOSED|DEVELOPMENT|CONSTRUCTION)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function addressSimilarity(left, right) {
    const leftTokens = new Set(normaliseAddress(left).split(" ").filter(token => token.length > 1));
    const rightTokens = new Set(normaliseAddress(right).split(" ").filter(token => token.length > 1));
    if (!leftTokens.size || !rightTokens.size) return 0;
    let common = 0;
    leftTokens.forEach(token => { if (rightTokens.has(token)) common += 1; });
    return (2 * common) / (leftTokens.size + rightTokens.size);
  }

  function eircode(value) {
    const match = text(value).toUpperCase().replace(/\s/g, "").match(/[A-Z0-9]{7}/);
    return match?.[0] || "";
  }

  function coordinate(value) {
    const parsed = Number(String(value ?? "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalisePoint(latitude, longitude) {
    let lat = coordinate(latitude);
    let lng = coordinate(longitude);
    if (lat == null || lng == null) return null;
    if (lat >= -11 && lat <= -5 && lng >= 51 && lng <= 56) [lat, lng] = [lng, lat];
    if (lat < 51 || lat > 56 || lng < -11 || lng > -5) return null;
    return { lat, lng };
  }

  function distanceMetres(leftLat, leftLng, rightLat, rightLng) {
    const left = normalisePoint(leftLat, leftLng);
    const right = normalisePoint(rightLat, rightLng);
    if (!left || !right) return null;
    const radius = 6371000;
    const radians = value => value * Math.PI / 180;
    const deltaLat = radians(right.lat - left.lat);
    const deltaLng = radians(right.lng - left.lng);
    const a = Math.sin(deltaLat / 2) ** 2
      + Math.cos(radians(left.lat)) * Math.cos(radians(right.lat)) * Math.sin(deltaLng / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(a));
  }

  function distancePoints(distance) {
    if (distance == null) return 0;
    if (distance <= 75) return 16;
    if (distance <= 150) return 14;
    if (distance <= 300) return 11;
    if (distance <= 750) return 7;
    if (distance <= 1500) return 3;
    return 0;
  }

  function parseTime(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    const date = new Date(Number.isFinite(numeric) && String(value).trim() !== "" ? numeric : value);
    const time = date.getTime();
    return Number.isFinite(time) ? time : null;
  }

  function isoDate(value) {
    const time = parseTime(value);
    return time == null ? "" : new Date(time).toISOString().slice(0, 10);
  }

  function earliestDate(values) {
    const times = values.map(parseTime).filter(value => value != null);
    return times.length ? Math.min(...times) : null;
  }

  function latestDate(values) {
    const times = values.map(parseTime).filter(value => value != null);
    return times.length ? Math.max(...times) : null;
  }

  function planningKey(record, index = 0) {
    const authority = canonicalAuthority(record.PlanningAuthority);
    const reference = normaliseReference(record.ApplicationNumber);
    return reference ? `${authority}|${reference}` : `${authority}|OID:${record.OBJECTID ?? index}`;
  }

  function commencementKey(record, index = 0) {
    const authority = canonicalAuthority(record.LocalAuthority);
    const numberValue = text(record.CN_Number);
    return numberValue ? `${authority}|${numberValue}` : `${authority}|ROW:${record.IDs ?? index}`;
  }

  function certificateKey(record, index = 0) {
    const authority = canonicalAuthority(record.LocalAuthority);
    const numberValue = text(record.CCC_Number);
    return numberValue ? `${authority}|${numberValue}` : `${authority}|ROW:${record.IDs ?? index}`;
  }

  function richness(record) {
    return [
      "PlanningAuthority", "ApplicationNumber", "AppealRefNumber", "DevelopmentAddress",
      "DevelopmentDescription", "NumResidentialUnits", "GrantDate", "DecisionDate",
      "Decision", "LinkAppDetails", "__lat", "__lng"
    ].reduce((score, field) => score + (record[field] !== null && record[field] !== undefined && record[field] !== "" ? 1 : 0), 0);
  }

  function mergePlanning(left, right) {
    const primary = richness(right) > richness(left) ? right : left;
    const secondary = primary === left ? right : left;
    const merged = { ...secondary, ...primary };
    Object.keys(secondary).forEach(key => {
      if (merged[key] == null || merged[key] === "") merged[key] = secondary[key];
    });
    merged.NumResidentialUnits = Math.max(number(left.NumResidentialUnits), number(right.NumResidentialUnits));
    return merged;
  }

  function dedupePlanning(records) {
    const output = new Map();
    records.forEach((record, index) => {
      const key = planningKey(record, index);
      output.set(key, output.has(key) ? mergePlanning(output.get(key), record) : { ...record, __planningKey: key });
    });
    return [...output.values()].map((record, index) => ({ ...record, __planningKey: planningKey(record, index) }));
  }

  function mergeNonEmpty(target, source) {
    Object.keys(source).forEach(key => {
      if ((target[key] == null || target[key] === "") && source[key] != null && source[key] !== "") target[key] = source[key];
    });
  }

  function consolidateNbcoRows(rows) {
    const commencements = new Map();
    rows.forEach((row, index) => {
      if (!text(row.CN_Number)) return;
      const key = commencementKey(row, index);
      if (!commencements.has(key)) {
        commencements.set(key, { ...row, __commencementKey: key, __sourceRows: [], __certificates: new Map() });
      }
      const commencement = commencements.get(key);
      mergeNonEmpty(commencement, row);
      commencement.__sourceRows.push(row);
      if (text(row.CCC_Number)) {
        const keyValue = certificateKey(row, index);
        if (!commencement.__certificates.has(keyValue)) commencement.__certificates.set(keyValue, { ...row, __certificateKey: keyValue });
        else mergeNonEmpty(commencement.__certificates.get(keyValue), row);
      }
    });

    return [...commencements.values()].map(commencement => {
      const sourceDates = commencement.__sourceRows.flatMap(row => [
        row.CN_Date_Submitted_or_Received,
        row.CN_Validation_Date,
        row.CN_Commencement_Date,
        row.CCC_Date_Validated
      ]);
      return {
        ...commencement,
        __certificates: [...commencement.__certificates.values()],
        __firstAppearance: earliestDate(sourceDates),
        __latestAppearance: latestDate(sourceDates)
      };
    });
  }

  function dateCompatibility(planning, commencement) {
    const planningDate = parseTime(planning.GrantDate || planning.DecisionDate);
    const commencementDate = parseTime(commencement.CN_Date_Granted || commencement.CN_Commencement_Date);
    if (planningDate == null || commencementDate == null) return 0;
    const days = Math.abs(planningDate - commencementDate) / 86400000;
    if (days <= 60) return 4;
    if (days <= 365) return 3;
    if (days <= 1095) return 1;
    return 0;
  }

  function unitCompatibility(planning, commencement) {
    const approved = number(planning.NumResidentialUnits);
    const building = Math.max(
      number(commencement.CN_Total_Number_of_Dwelling_Units),
      number(commencement.CN_Total_Number_Multiple_Unit_Dwellings),
      number(commencement.CN_Units_for_phase)
    );
    if (!approved || !building) return 0;
    const ratio = Math.min(approved, building) / Math.max(approved, building);
    if (ratio >= 0.9) return 4;
    if (ratio >= 0.65) return 3;
    if (ratio >= 0.4) return 1;
    return 0;
  }

  function scoreCandidate(planning, commencement) {
    const planningTokens = referenceTokens(planning.ApplicationNumber);
    const planningAcp = acpReference(planning.AppealRefNumber);
    const buildingTokens = referenceTokens(commencement.CN_Planning_Permission_Number);
    const buildingNormal = normaliseReference(commencement.CN_Planning_Permission_Number);
    let score = 0;
    const reasons = [];
    let referenceType = "";

    const exactReference = planningTokens.some(token => buildingTokens.includes(token));
    const containedReference = !exactReference && Boolean(buildingNormal)
      && planningTokens.some(token => buildingNormal.includes(token) || token.includes(buildingNormal));
    const acpMatch = Boolean(planningAcp)
      && (buildingTokens.includes(planningAcp) || buildingNormal.includes(planningAcp));

    if (exactReference) {
      score += 65;
      reasons.push("exact planning reference");
      referenceType = "exact planning reference";
    } else if (containedReference) {
      score += 55;
      reasons.push("planning reference token");
      referenceType = "planning reference token";
    } else if (acpMatch) {
      score += 50;
      reasons.push("ACP reference");
      referenceType = "ACP reference";
    }

    const planningAuthority = canonicalAuthority(planning.PlanningAuthority);
    const buildingAuthority = canonicalAuthority(commencement.LocalAuthority || commencement.CN_County);
    const authorityMatch = Boolean(planningAuthority && buildingAuthority && planningAuthority === buildingAuthority);
    if (authorityMatch) {
      score += 15;
      reasons.push("local authority");
    } else if (planningAuthority && buildingAuthority) {
      score -= 20;
      reasons.push("authority conflict");
    }

    const planningAddress = `${planning.DevelopmentAddress || ""} ${planning.DevelopmentDescription || ""}`;
    const buildingAddress = `${commencement.CN_Project_Name || ""} ${commencement.CN_Street || ""} ${commencement.CN_Town || ""} ${commencement.CN_Description_proposed_development || ""}`;
    const addressScore = addressSimilarity(planningAddress, buildingAddress);
    if (addressScore >= 0.18) {
      const points = Math.min(16, Math.max(3, Math.round(addressScore * 16)));
      score += points;
      reasons.push(`address ${Math.round(addressScore * 100)}%`);
    }

    const planningEircode = eircode(planningAddress);
    const buildingEircode = eircode(`${commencement.CN_Eircode || ""} ${buildingAddress}`);
    const eircodeMatch = Boolean(planningEircode && buildingEircode && planningEircode === buildingEircode);
    if (eircodeMatch) {
      score += 18;
      reasons.push("Eircode");
    }

    const distance = distanceMetres(planning.__lat, planning.__lng, commencement.CN_LAT, commencement.CN_LNG);
    const spatialPoints = distancePoints(distance);
    if (spatialPoints) {
      score += spatialPoints;
      reasons.push(`${Math.round(distance)} m`);
    }

    const datePoints = dateCompatibility(planning, commencement);
    if (datePoints) {
      score += datePoints;
      reasons.push("grant date");
    }

    const unitPoints = unitCompatibility(planning, commencement);
    if (unitPoints) {
      score += unitPoints;
      reasons.push("unit scale");
    }

    const locationSupport = eircodeMatch || addressScore >= 0.25 || (distance != null && distance <= 1500);
    const referenceSupport = Boolean(referenceType);
    const autoEligible = authorityMatch && referenceSupport && locationSupport;

    return {
      score: Math.max(0, Math.min(100, score)),
      reasons: reasons.join(" · ") || "no supporting evidence",
      referenceType,
      authorityMatch,
      addressScore,
      eircodeMatch,
      distance,
      locationSupport,
      autoEligible
    };
  }

  function candidateIndexes(planningRows) {
    const byReference = new Map();
    const byAcp = new Map();
    const byAuthority = new Map();
    planningRows.forEach(planning => {
      referenceTokens(planning.ApplicationNumber).forEach(token => {
        if (!byReference.has(token)) byReference.set(token, new Set());
        byReference.get(token).add(planning);
      });
      const acp = acpReference(planning.AppealRefNumber);
      if (acp) {
        if (!byAcp.has(acp)) byAcp.set(acp, new Set());
        byAcp.get(acp).add(planning);
      }
      const authority = canonicalAuthority(planning.PlanningAuthority);
      if (!byAuthority.has(authority)) byAuthority.set(authority, []);
      byAuthority.get(authority).push(planning);
    });
    return { byReference, byAcp, byAuthority };
  }

  function shortlistAuthorityCandidates(commencement, authorityRows) {
    const buildingAddress = `${commencement.CN_Project_Name || ""} ${commencement.CN_Street || ""} ${commencement.CN_Town || ""} ${commencement.CN_Description_proposed_development || ""}`;
    const buildingEircode = eircode(`${commencement.CN_Eircode || ""} ${buildingAddress}`);
    return authorityRows.filter(planning => {
      const planningAddress = `${planning.DevelopmentAddress || ""} ${planning.DevelopmentDescription || ""}`;
      const planningEircode = eircode(planningAddress);
      if (buildingEircode && planningEircode === buildingEircode) return true;
      const distance = distanceMetres(planning.__lat, planning.__lng, commencement.CN_LAT, commencement.CN_LNG);
      if (distance != null && distance <= 3000) return true;
      return addressSimilarity(planningAddress, buildingAddress) >= 0.22;
    });
  }

  function matchCommencements(planningRows, commencementRows) {
    const planning = dedupePlanning(planningRows);
    const commencements = Array.isArray(commencementRows) && commencementRows.some(row => row.__sourceRows)
      ? commencementRows
      : consolidateNbcoRows(commencementRows || []);
    const indexes = candidateIndexes(planning);
    const automatic = [];
    const review = [];
    const unmatched = [];

    commencements.forEach(commencement => {
      const candidates = new Set();
      referenceTokens(commencement.CN_Planning_Permission_Number).forEach(token => {
        indexes.byReference.get(token)?.forEach(record => candidates.add(record));
        if (/^\d{6}$/.test(token)) indexes.byAcp.get(token)?.forEach(record => candidates.add(record));
      });
      const authority = canonicalAuthority(commencement.LocalAuthority || commencement.CN_County);
      if (!candidates.size) {
        shortlistAuthorityCandidates(commencement, indexes.byAuthority.get(authority) || [])
          .forEach(record => candidates.add(record));
      }

      const ranked = [...candidates]
        .map(record => ({ planning: record, commencement, ...scoreCandidate(record, commencement) }))
        .filter(candidate => candidate.score >= 45)
        .sort((left, right) => right.score - left.score || String(left.planning.ApplicationNumber).localeCompare(String(right.planning.ApplicationNumber)));

      const best = ranked[0];
      if (!best) {
        unmatched.push({ commencement, reason: "No planning candidate", candidates: [] });
        return;
      }
      const margin = best.score - (ranked[1]?.score ?? 0);
      const result = { ...best, margin, candidates: ranked.slice(0, 3) };
      if (best.score >= 80 && best.autoEligible && margin >= 8) automatic.push(result);
      else if (best.score >= 65) review.push(result);
      else unmatched.push({ commencement, reason: "No candidate reached the review threshold", candidates: ranked.slice(0, 3) });
    });

    return { planning, commencements, automatic, review, unmatched };
  }

  function isNotCommenced(record) {
    const value = text(record.CN_Not_Commenced).toUpperCase();
    return value === "1" || value === "TRUE" || value === "YES";
  }

  function validCertificate(record) {
    return Boolean(text(record.CCC_Number) && parseTime(record.CCC_Date_Validated) != null);
  }

  function aggregateProjects(matchResult) {
    const planningMap = new Map(matchResult.planning.map(record => [record.__planningKey || planningKey(record), record]));
    const assignments = new Map();
    matchResult.automatic.forEach(match => {
      const key = match.planning.__planningKey || planningKey(match.planning);
      if (!assignments.has(key)) assignments.set(key, []);
      assignments.get(key).push(match);
    });

    const projects = [];
    const commencementRows = [];
    const certificateRows = [];

    assignments.forEach((matches, key) => {
      const planning = planningMap.get(key);
      if (!planning) return;
      const commencementMap = new Map();
      const certificateMap = new Map();
      matches.forEach(match => {
        const commencement = match.commencement;
        commencementMap.set(commencement.__commencementKey || commencementKey(commencement), commencement);
        (commencement.__certificates || []).forEach(certificate => {
          if (validCertificate(certificate)) certificateMap.set(certificate.__certificateKey || certificateKey(certificate), certificate);
        });
      });
      const commencements = [...commencementMap.values()];
      const validCommencements = commencements.filter(record => !isNotCommenced(record) && parseTime(record.CN_Commencement_Date) != null);
      const certificates = [...certificateMap.values()];
      const phaseUnits = validCommencements.reduce((sum, record) => sum + Math.max(0, number(record.CN_Units_for_phase)), 0);
      const totalUnitsFallback = Math.max(0, ...validCommencements.map(record => Math.max(
        number(record.CN_Total_Number_of_Dwelling_Units),
        number(record.CN_Total_Number_Multiple_Unit_Dwellings)
      )));
      const unitsCommenced = phaseUnits > 0 ? phaseUnits : totalUnitsFallback;
      const unitsCompleted = certificates.reduce((sum, record) => sum + Math.max(0, number(record.CCC_Units_Completed)), 0);
      const approvedUnits = number(planning.NumResidentialUnits);
      const firstAppearance = earliestDate(commencements.flatMap(record => [
        record.CN_Date_Submitted_or_Received,
        record.CN_Validation_Date,
        record.CN_Commencement_Date,
        ...(record.__certificates || []).map(certificate => certificate.CCC_Date_Validated)
      ]));
      const firstCommencement = earliestDate(validCommencements.map(record => record.CN_Commencement_Date));
      const latestCommencement = latestDate(validCommencements.map(record => record.CN_Commencement_Date));
      const firstCompletion = earliestDate(certificates.map(record => record.CCC_Date_Validated));
      const latestCompletion = latestDate(certificates.map(record => record.CCC_Date_Validated));
      const fullCertificate = certificates.some(record => /full completion|all buildings|full certificate/i.test(text(record.CCC_Type_of_Completion_Certificate)));
      const completeByUnits = approvedUnits > 0 && unitsCompleted >= approvedUnits;
      let status = "Matched";
      if (validCommencements.length) status = "Commenced";
      if (certificates.length) status = "Completion evidence";
      if (fullCertificate || completeByUnits) status = "Completed";
      const scores = matches.map(match => match.score);
      const project = {
        planningKey: key,
        planningRef: text(planning.ApplicationNumber),
        acpRef: acpReference(planning.AppealRefNumber),
        authority: text(planning.PlanningAuthority),
        address: text(planning.DevelopmentAddress || planning.DevelopmentDescription),
        approvedUnits,
        firstAppearance,
        firstCommencement,
        latestCommencement,
        firstCompletion,
        latestCompletion,
        commencementCount: commencements.length,
        commencementNumbers: commencements.map(record => text(record.CN_Number)).filter(Boolean),
        unitsCommenced,
        certificateCount: certificates.length,
        certificateNumbers: certificates.map(record => text(record.CCC_Number)).filter(Boolean),
        unitsCompleted,
        completionEvidence: certificates.length > 0,
        completed: fullCertificate || completeByUnits,
        status,
        minMatchScore: scores.length ? Math.min(...scores) : 0,
        maxMatchScore: scores.length ? Math.max(...scores) : 0,
        matchMethods: [...new Set(matches.map(match => match.reasons))],
        planningUrl: text(planning.LinkAppDetails)
      };
      projects.push(project);

      matches.forEach(match => {
        const record = match.commencement;
        commencementRows.push({
          planningRef: project.planningRef,
          acpRef: project.acpRef,
          authority: project.authority,
          address: project.address,
          cnNumber: text(record.CN_Number),
          firstAppeared: record.__firstAppearance,
          submitted: parseTime(record.CN_Date_Submitted_or_Received),
          validated: parseTime(record.CN_Validation_Date),
          commencementDate: parseTime(record.CN_Commencement_Date),
          phase: number(record.CN_Phase_for_this_Notice) || "",
          phaseUnits: number(record.CN_Units_for_phase) || "",
          totalUnits: Math.max(number(record.CN_Total_Number_of_Dwelling_Units), number(record.CN_Total_Number_Multiple_Unit_Dwellings)) || "",
          matchScore: match.score,
          matchMethod: match.reasons
        });
        (record.__certificates || []).filter(validCertificate).forEach(certificate => {
          certificateRows.push({
            planningRef: project.planningRef,
            acpRef: project.acpRef,
            authority: project.authority,
            address: project.address,
            cnNumber: text(record.CN_Number),
            cccNumber: text(certificate.CCC_Number),
            validated: parseTime(certificate.CCC_Date_Validated),
            type: text(certificate.CCC_Type_of_Completion_Certificate),
            unitsCompleted: number(certificate.CCC_Units_Completed) || "",
            description: text(certificate.CCC_Description)
          });
        });
      });
    });

    const uniqueCommencementRows = new Map();
    commencementRows.forEach(row => uniqueCommencementRows.set(`${row.authority}|${row.cnNumber}`, row));
    const uniqueCertificateRows = new Map();
    certificateRows.forEach(row => uniqueCertificateRows.set(`${row.authority}|${row.cccNumber}`, row));

    projects.sort((left, right) => (right.firstAppearance || 0) - (left.firstAppearance || 0) || right.approvedUnits - left.approvedUnits);
    return {
      projects,
      commencements: [...uniqueCommencementRows.values()],
      certificates: [...uniqueCertificateRows.values()],
      review: matchResult.review,
      unmatched: matchResult.unmatched
    };
  }

  return {
    text,
    number,
    canonicalAuthority,
    normaliseReference,
    referenceTokens,
    acpReference,
    normaliseAddress,
    addressSimilarity,
    eircode,
    coordinate,
    normalisePoint,
    distanceMetres,
    parseTime,
    isoDate,
    earliestDate,
    latestDate,
    planningKey,
    commencementKey,
    certificateKey,
    dedupePlanning,
    consolidateNbcoRows,
    scoreCandidate,
    matchCommencements,
    aggregateProjects
  };
});
