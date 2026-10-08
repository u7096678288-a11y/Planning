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

ROOT = Path("preview-r8/data")
OUT = ROOT / "major-schemes.json"
EVIDENCE = ROOT / "applicant-enrichment.json"
SOURCE = Path("preview-r8/scripts/enrich_applicants.py")
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
                "description": clean(row.get("DevelopmentDescription"), 200),
                "decision": clean(row.get("Decision"), 90),
                "received": date_value(row.get("ReceivedDate")),
                "applicant": native or previous_record.get("applicant", ""),
                "applicantSourceType": "National planning feed" if native else previous_record.get("applicantSourceType", ""),
                "source": clean(row.get("LinkAppDetails"), 400),
            }
        start_offset += len(rows)
        if len(rows) < PAGE_SIZE:
            complete = True
            break
        if page % 5 == 0:
            print("Scanned", start_offset, "records")
    return found, complete, start_offset, failures

def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    previous = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    evidence = json.loads(EVIDENCE.read_text(encoding="utf-8"))
    records = evidence.setdefault("records", {})
    checked = evidence.setdefault("majorSchemeChecked", {})
    found, complete, scanned, errors = scan(previous)
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
        name = base.official_name(item["source"])
        if not name:
            continue
        item["applicant"] = name
        item["applicantSourceType"] = "Official council application"
        records.setdefault(item["key"], {}).update({
            "applicant": name, "applicantSource": item["source"],
            "applicantEvidence": "Explicit applicant name on linked official council application",
            "verifiedAt": base.TODAY,
        })
        added += 1
    projects = sorted(found.values(), key=lambda p: (p.get("received", ""), p["key"]), reverse=True)
    # Avoid reporting an exhaustive catalogue unless a full scan completed.
    stats = {
        "indexed": len(projects),
        "named": sum(bool(p["applicant"]) for p in projects),
        "unnamed": sum(not p["applicant"] for p in projects),
        "officialPagesCheckedThisRun": visited,
        "newNamesFromOfficialPages": added,
        "scanComplete": complete,
        "scanRows": scanned,
        "errors": errors,
        "threshold": ">100 residential units per application",
        "note": "Counts refer to planning application records, not deduplicated developments. Applicant names are exact legal names; developer groups are not inferred."
    }
    result = {"schemaVersion": 1, "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "scanOffset": 0 if complete else scanned,
              "stats": stats, "projects": projects}
    OUT.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    evidence["updatedAt"] = result["updatedAt"]
    EVIDENCE.write_text(json.dumps(evidence, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(stats))
    if not projects:
        raise RuntimeError("No large scheme records found; retaining prior data")

if __name__ == "__main__":
    main()
