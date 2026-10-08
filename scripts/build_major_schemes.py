#!/usr/bin/env python3
"""Build a cached, national >100-home application catalogue for the preview.

All records are scanned from the national planning service, including those
without applicant names. Names come from source applicant fields or from
explicitly labelled applicant fields on official council pages, never guesses.
"""
import datetime as dt
import importlib.util
import json
import re
import time
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path("preview-r9/data")
OUT = ROOT / "major-schemes.json"
EVIDENCE = ROOT / "applicant-enrichment.json"
SOURCE = Path("preview-r9/scripts/enrich_applicants.py")
spec = importlib.util.spec_from_file_location("scheme_enrichment", SOURCE)
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

MIN_UNITS = 101
PAGE_SIZE = 500
MAX_PAGES = 150
MAX_LOOKUPS = 220
MAX_SECONDS = 470
started = time.monotonic()
base.MAX_SITE_VISITS = MAX_LOOKUPS + 5
base.MAX_RUN_SECONDS = MAX_SECONDS - 25
spec2 = importlib.util.spec_from_file_location("major_scheme_logic", Path("preview-r9/scripts/major_scheme_logic.py"))
logic = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(logic)

def clean(value, length=200):
    return " ".join(str(value or "").split())[:length]

def key(authority, ref):
    return base.key_for(authority, ref)

def date_value(value):
    if isinstance(value, (int, float)) and value > 100000000000:
        return dt.datetime.fromtimestamp(value / 1000, tz=dt.timezone.utc).date().isoformat()
    return clean(value, 20)

def applicant_from_feed(row):
    return base.valid_name(" ".join(filter(None, [
        clean(row.get("ApplicantForename"), 100),
        clean(row.get("ApplicantSurname"), 100)
    ])))

def scan(previous):
    # The ordered offset is saved if the service interrupts the scan.
    found = {p["key"]: p for p in previous.get("projects", []) if p.get("key")}
    start_offset = int(previous.get('scanOffset', 0) or 0)
    complete = False
    failures = []
    for page in range(MAX_PAGES):
        if time.monotonic() - started > MAX_SECONDS - 140:
            break
        try:
            rows = base.query(base.PLANNING, "NumResidentialUnits > 100",
                "PlanningAuthority,ApplicationNumber,NumResidentialUnits,ApplicantForename,ApplicantSurname,LinkAppDetails,DevelopmentAddress,DevelopmentDescription,Decision,ReceivedDate",
                PAGE_SIZE, "ReceivedDate DESC,ApplicationNumber ASC", start_offset)
        except Exception as error:
            failures.append(str(error)[:180])
            break
        for row in rows:
            authority = clean(row.get("PlanningAuthority"), 110)
            ref = clean(row.get("ApplicationNumber"), 70)
            if not authority or not ref:
                continue
            identifier = key(authority, ref)
            units = row.get("NumResidentialUnits")
            try:
                units = int(float(units))
            except (ValueError, TypeError):
                continue
            if units <= 100:
                continue
            previous_record = found.get(identifier, {})
            native = applicant_from_feed(row)
            found[identifier] = {
                "key": identifier,
                "reference": ref,
                "authority": authority,
                "units": units,
                "address": clean(row.get("DevelopmentAddress"), 180),
                "description": clean(row.get("DevelopmentDescription"), 700),
                "decision": clean(row.get("Decision"), 90),
                "received": date_value(row.get("ReceivedDate")),
                "applicant": native or previous_record.get("applicant", ""),
                "applicantSourceType": "National planning feed" if native else previous_record.get("applicantSourceType", ""),
                "source": clean(row.get("LinkAppDetails"), 400),
                "kind": "planning",
            }
        start_offset += len(rows)
        if len(rows) < PAGE_SIZE:
            complete = True
            break
        if page % 5 == 0:
            print("Scanned", start_offset, "records")
    return found, complete, start_offset, failures

def scan_cork(found):
    """Supplement national feed with Cork City open-data applications."""
    resource = "8d5bbfa9-3b0c-40ac-8630-4243bed94b2d"
    endpoint = "https://data.corkcity.ie/api/3/action/datastore_search_sql"
    count = 0
    try:
        for offset in range(0, 30000, 1000):
            sql = ('SELECT * FROM "' + resource + '" WHERE "NumResidentialUnits" > 100 '
                   'ORDER BY "ReceivedDate" DESC NULLS LAST LIMIT 1000 OFFSET ' + str(offset))
            data = json.loads(base.get(endpoint + "?" + urlencode({"sql": sql}), 3_000_000))
            if not data.get("success"):
                raise RuntimeError(str(data.get("error", "Cork SQL error"))[:160])
            rows = data.get("result", {}).get("records", [])
            for row in rows:
                ref = clean(row.get("ApplicationNumber"), 70)
                if not ref:
                    continue
                try:
                    units = int(float(row.get("NumResidentialUnits") or 0))
                except (ValueError, TypeError):
                    continue
                if units <= 100:
                    continue
                identifier = key("Cork City Council", ref)
                previous = found.get(identifier, {})
                native = applicant_from_feed(row)
                found[identifier] = {
                    "key": identifier, "reference": ref, "authority": "Cork City Council",
                    "units": units,
                    "address": clean(row.get("DevelopmentAddress"), 180),
                    "description": clean(row.get("DevelopmentDescription"), 200),
                    "decision": clean(row.get("Decision"), 90),
                    "received": date_value(row.get("ReceivedDate")),
                    "applicant": native or previous.get("applicant", ""),
                    "applicantSourceType": "Cork City Council open data" if native else previous.get("applicantSourceType", ""),
                    "source": clean(row.get("LinkAppDetails"), 400),
                "kind": "planning",
                }
                count += 1
            if len(rows) < 1000:
                break
    except Exception as error:
        print("Cork City catalogue unavailable:", str(error)[:180])
    return count


def scan_acp(found, evidence, previous):
    """Add ACP cases with explicit >100 units or an exact matching council record."""
    offset = int(previous.get("acpOffset", 0) or 0)
    count, complete, errors = 0, False, []
    where = ("(CATEGORY LIKE '%Housing%' OR CATEGORY LIKE '%LRD%' OR "
             "CATEGORY LIKE '%SHD%' OR DEVDESC LIKE '%residential%' OR "
             "DEVDESC LIKE '%apartments%' OR DEVDESC LIKE '%dwellings%')")
    for page in range(30):
        if time.monotonic() - started > 145:
            break
        try:
            rows = base.query(base.ACP, where, "*", 500, "LODGEDON DESC,ABPCASEID ASC", offset)
        except Exception as error:
            errors.append(str(error)[:180])
            break
        if page == 0 and rows:
            print("ACP available fields:", sorted(rows[0].keys()))
        for row in rows:
            match = re.search(r"\d{6}", str(row.get("ABPCASEID") or ""))
            if not match:
                continue
            case_id = match.group()
            identifier = "acp|" + case_id
            proof = evidence.get(identifier, {})
            authority = clean(row.get("PLANINGATY") or proof.get("planningAuthority"), 110)
            ref = clean(proof.get("planningReference") or row.get("PLANREF") or
                        row.get("PLANNINGREF") or row.get("PLANNING_REF"), 80)
            desc = clean(row.get("DEVDESC"), 3000)
            units = logic.extract_units(desc)
            duplicate = ""
            if authority and ref:
                target = key(authority, ref)
                if target in found and found[target].get("kind", "planning") == "planning":
                    duplicate = target
                    units = max(units, int(found[target].get("units") or 0))
            if units <= 100:
                continue
            old = found.get(identifier, {})
            applicant = (base.valid_name(row.get("APPLICANTNAME") or row.get("APPLICANT_NAME") or
                                         row.get("APPLICANT") or "") or
                         proof.get("applicant") or old.get("applicant", ""))
            found[identifier] = {
                "key": identifier, "kind": "acp", "caseId": case_id,
                "reference": case_id, "authority": authority or "An Coimisiún Pleanála",
                "planningReference": ref, "units": units,
                "unitsSource": "Matched council application" if duplicate else "ACP case description",
                "address": clean(row.get("DEVADDRESS"), 180),
                "description": clean(desc, 350),
                "decision": clean(row.get("DECISION"), 90),
                "received": date_value(row.get("LODGEDON")),
                "applicant": applicant,
                "applicantSourceType": "Official ACP case or matched council record" if applicant else "",
                "source": logic.project_url(row.get("LINKABPWEB"), "acp", case_id),
                "possibleDuplicateOf": duplicate,
                "duplicateReason": "Exact planning authority and reference" if duplicate else "",
                "category": clean(row.get("CATEGORY"), 90),
            }
            count += 1
        offset += len(rows)
        if len(rows) < 500:
            complete = True
            break
    return count, complete, 0 if complete else offset, errors

def classify_and_match(found, evidence):
    for item in found.values():
        proof = evidence.get(item["key"], {})
        if not item.get("applicant") and proof.get("applicant") and proof.get("applicantSource"):
            item["applicant"] = proof["applicant"]
            item["applicantSourceType"] = "Verified official source"
        if proof.get("developer") and proof.get("developerSource"):
            item["developer"] = proof["developer"]
            item["developerSource"] = proof["developerSource"]
        item["brand"] = logic.brand_from_applicant(item.get("applicant"))
        desc = item.get("description", "")
        item["type"] = logic.scheme_type(desc, item.get("reference", ""), item.get("category", ""))
        item["siteName"] = logic.site_name(item.get("address", ""), desc)
        item["source"] = logic.project_url(item.get("source", ""), item.get("kind"), item.get("caseId"))
        if not item["source"] and item.get("authority") == "Dublin City Council":
            item["source"] = "https://planning.agileapplications.ie/dublincity"
            item["sourceLinkType"] = "Council search — enter reference"
        item["unitsSource"] = item.get("unitsSource") or "National planning feed"
    # Flag, but do not merge, same-council applications with identical
    # substantial site addresses and unit counts (often amendments or FEPs).
    seen_sites = {}
    for item in sorted(found.values(), key=lambda x: (x.get("received", ""), x["key"])):
        if item.get("kind") != "planning" or item.get("possibleDuplicateOf"):
            continue
        addr = logic.compact(item.get("address", ""))
        if len(addr) < 18:
            continue
        site_key = (logic.compact(item.get("authority")), addr, item.get("units"))
        earlier = seen_sites.get(site_key)
        if earlier and earlier != item["key"]:
            item["possibleDuplicateOf"] = earlier
            item["duplicateReason"] = "Possible same-site overlap: identical council, address and unit count"
        else:
            seen_sites[site_key] = item["key"]
    for item in found.values():
        if item.get("kind") != "acp" or item.get("possibleDuplicateOf"):
            continue
        proof = evidence.get(item["key"], {})
        authority = proof.get("planningAuthority") or item.get("authority", "")
        ref = proof.get("planningReference") or item.get("planningReference", "")
        target = key(authority, ref) if authority and ref else ""
        if target in found and found[target].get("kind") == "planning":
            item["possibleDuplicateOf"] = target
            item["duplicateReason"] = "Exact planning authority and reference"
            item["planningReference"] = ref
            if not item.get("applicant") and found[target].get("applicant"):
                item["applicant"] = found[target]["applicant"]
                item["applicantSourceType"] = "Matched council application"

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    records = evidence.setdefault("records", {})
    checked = evidence.setdefault("majorSchemeChecked", {})
    found, complete, scanned, errors = scan(previous)
    cork_count = scan_cork(found)
    acp_count, acp_complete, acp_offset, acp_errors = scan_acp(found, records, previous)
    errors.extend(acp_errors)
    # Use verified enrichment already collected, but never substitute a promoter
    # or inferred brand for a legal applicant.
    for item in found.values():
        proof = records.get(item["key"], {})
        if not item["applicant"] and proof.get("applicant") and proof.get("applicantSource"):
            item["applicant"] = proof["applicant"]
            item["applicantSourceType"] = "Official council application"
    missing = [p for p in found.values() if not p["applicant"] and base.official_url(p.get("source", ""))]
    # Prioritise recent applications that have not yet been checked; rotate failures.
    missing.sort(key=lambda p: p.get("received", ""), reverse=True)
    missing.sort(key=lambda p: bool(checked.get(p["key"])))
    visited = 0
    added = 0
    for item in missing:
        if visited >= MAX_LOOKUPS or time.monotonic() - started > MAX_SECONDS:
            break
        last = checked.get(item["key"], "")
        if last:
            try:
                if (dt.date.today() - dt.date.fromisoformat(last)).days < 21:
                    continue
            except ValueError:
                pass
        checked[item["key"]] = base.TODAY
        visited += 1
        name = ""
        applicant_source = item["source"]
        evidence_text = "Explicit applicant name on linked official council application"
        if item.get("kind") == "acp":
            try:
                markup = base.get(item["source"])
                name = base.extract_applicant(markup)
                text = base.TextToPlain(markup)
                match = re.search(r"Planning Authority Case Reference:\s*([A-Za-z0-9/.-]+)", text, re.I)
                if match and item.get("authority"):
                    council_ref = match.group(1)
                    item["planningReference"] = council_ref
                    target = key(item["authority"], council_ref)
                    if target in found and found[target].get("kind") == "planning":
                        item["possibleDuplicateOf"] = target
                        item["duplicateReason"] = "Exact planning authority and reference from official ACP case"
                        council = found[target]
                        if not name and council.get("applicant"):
                            name = council["applicant"]
                            applicant_source = council.get("source") or applicant_source
                            evidence_text = "ACP case matched to the exact council application reference"
            except Exception as error:
                print("ACP case inspection skipped:", item.get("caseId"), str(error)[:110])
        else:
            name = base.official_name(item["source"])
        if not name:
            continue
        item["applicant"] = name
        item["applicantSourceType"] = "Official linked planning source"
        records.setdefault(item["key"], {}).update({
            "applicant": name, "applicantSource": applicant_source,
            "applicantEvidence": evidence_text,
            "planningReference": item.get("planningReference", ""),
            "planningAuthority": item.get("authority", ""),
            "verifiedAt": base.TODAY,
        })
        added += 1
    classify_and_match(found, records)
    projects = sorted(found.values(), key=lambda p: (p.get("received", ""), p["key"]), reverse=True)
    # Avoid reporting an exhaustive catalogue unless a full scan completed.
    stats = {
        "indexed": len(projects),
        "corkCityApplications": cork_count,
        "acpCasesFound": acp_count,
        "acpCasesIndexed": sum(p.get("kind")=="acp" for p in projects),
        "acpScanComplete": acp_complete,
        "possibleDuplicateCases": sum(bool(p.get("possibleDuplicateOf")) for p in projects),
        "named": sum(bool(p["applicant"]) for p in projects),
        "unnamed": sum(not p["applicant"] for p in projects),
        "officialPagesCheckedThisRun": visited,
        "newNamesFromOfficialPages": added,
        "scanComplete": complete,
        "scanRows": scanned,
        "errors": errors,
        "threshold": ">100 residential units per application",
        "note": "Counts refer to indexed council applications and ACP cases, not deduplicated developments. Cases without evidence of more than 100 homes are excluded. Applicants and promoters are distinct."
    }
    result = {"schemaVersion": 1, "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "scanOffset": 0 if complete else scanned,
              "acpOffset": acp_offset,
              "stats": stats, "projects": projects}
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    evidence["updatedAt"] = result["updatedAt"]
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(stats))
    if not projects:
        raise RuntimeError("No large scheme records found; retaining prior data")

if __name__ == "__main__":
    main()
