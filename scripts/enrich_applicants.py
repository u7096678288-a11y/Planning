#!/usr/bin/env python3
"""Conservative, source-backed enrichment of larger Irish housing applications.

Reads/writes only preview-r10/data/applicant-enrichment.json. Never guesses an
applicant from an address, developer brand, or unstructured development text.
"""
import datetime as dt
import html
import json
import os
import re
import sys
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

DATA = Path("preview-r10/data/applicant-enrichment.json")
PLANNING = "https://services.arcgis.com/NzlPQPKn5QF9v2US/ArcGIS/rest/services/IrishPlanningApplications/FeatureServer/0/query"
ACP = "https://services-eu1.arcgis.com/o56BSnENmD5mYs3j/ArcGIS/rest/services/Cases_2016_Onwards/FeatureServer/3/query"
TODAY = dt.date.today().isoformat()
MAX_SITE_VISITS = 45
MAX_PLANNING_VISITS = 22
MAX_ACP_CASES = 30
site_visits = 0
MAX_RUN_SECONDS = 260
started = time.monotonic()
UA = "RadharcPleanalaApplicantEnrichment/1.0 (+public planning data, low-frequency)"
INVALID = re.compile(r"^(?:n/?a|none|unknown|not\s+(?:provided|available)|redacted|applicant|private|individual|tbc|to be confirmed)$", re.I)
FIELD = re.compile(r"^(?:applicant\s+name|applicant['’]s\s+name|name\s+of\s+(?:the\s+)?applicant|applicant\(s\)|applicant\s*:)\s*:?\s*(.*)$", re.I)

class Text(HTMLParser):
    def __init__(self):
        super().__init__()
        self.lines = []
        self.current = []
        self.skip = 0
    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self.skip += 1
        if tag in ("td", "th", "tr", "p", "div", "li", "dt", "dd", "br", "h1", "h2", "h3", "label"):
            self.flush()
    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript"):
            self.skip = max(0, self.skip - 1)
        if tag in ("td", "th", "tr", "p", "div", "li", "dt", "dd", "br", "h1", "h2", "h3", "label"):
            self.flush()
    def handle_data(self, data):
        if not self.skip:
            self.current.append(data)
    def flush(self):
        s = " ".join(" ".join(self.current).split())
        if s:
            self.lines.append(html.unescape(s))
        self.current = []

def valid_name(value):
    value = " ".join(str(value or "").split()).strip(" :\t\n\r-")
    if not 3 <= len(value) <= 160 or INVALID.fullmatch(value) or len(value.split()) < 2:
        return ""
    if re.search(r"https?://|www\.|[{}<>]|\b(?:click|view|details|application|search|register|address|planning|status|permission|scheme|information|documents|location|map)\b", value, re.I):
        return ""
    if not re.search(r"[A-Za-z]", value):
        return ""
    return value

def official_url(url):
    try:
        u = urlsplit(str(url or "").strip())
        host = (u.hostname or "").lower()
        if u.scheme not in ("https", "http") or not host or u.username or u.password:
            return False
        if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal"):
            return False
        # Council portals, the Commission and Irish official public planning hosts.
        councils = ("galwaycity.ie", "corkcity.ie", "dublincity.ie", "limerick.ie", "fingal.ie", "sdublincoco.ie", "dlrcoco.ie", "meath.ie", "wicklow.ie", "kildarecoco.ie", "kilkennycoco.ie", "clarecoco.ie", "mayo.ie", "laois.ie", "offaly.ie", "carlow.ie", "leitrim.ie", "monaghan.ie")
        return (host == "planning.agileapplications.ie" or
                host in councils or any(host.endswith("." + c) for c in councils) or
                host == "pleanala.ie" or host.endswith(".pleanala.ie") or
                host == "planning.localgov.ie" or host.endswith(".coco.ie") or
                host.endswith(".citycouncil.ie") or host.endswith(".gov.ie") or
                host in ("www.eplanning.ie", "eplanning.ie", "planning.ie") or
                (host.endswith(".ie") and ("planning" in host or "council" in host)))
    except Exception:
        return False

def get(url, max_bytes=1_000_000):
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/json,text/html;q=0.9"})
    with urlopen(req, timeout=14) as response:
        if not official_url(response.url) and not response.url.startswith(("https://services.arcgis.com/", "https://services-eu1.arcgis.com/")):
            raise ValueError("Redirect to an unapproved host")
        return response.read(max_bytes).decode("utf-8", "replace")

def query(endpoint, where, fields, limit=250, order="", offset=0):
    params = {"f": "json", "where": where, "outFields": fields, "returnGeometry": "false", "resultRecordCount": limit, "resultOffset": offset}
    if order:
        params["orderByFields"] = order
    data = json.loads(get(endpoint + "?" + urlencode(params), 2_000_000))
    if data.get("error"):
        raise RuntimeError(str(data["error"].get("message")))
    return [f.get("attributes", {}) for f in data.get("features", [])]

def extract_applicant(markup):
    # Structural Applicant -> value pairs are safe even when the label is
    # simply "Applicant"; a navigation tab with that text is not evidence.
    structural = re.search(
        r"<(?:dt|th)\b[^>]*>\s*(?:Applicant|Applicant\s+Name)\s*:?\s*</(?:dt|th)>\s*"
        r"<(?:dd|td)\b[^>]*>(.*?)</(?:dd|td)>", markup, re.I | re.S)
    if structural:
        value = html.unescape(re.sub(r"<[^>]*>", " ", structural.group(1)))
        name = valid_name(value)
        if name:
            return name
    parser = Text()
    parser.feed(markup)
    parser.flush()
    lines = parser.lines
    for i, line in enumerate(lines):
        # A lone navigation tab labelled "Applicant" is not an applicant field.
        if line.strip().lower() == "applicant":
            continue
        match = FIELD.match(line)
        if not match:
            continue
        inline = valid_name(match.group(1))
        if inline:
            return inline
        for next_line in lines[i+1:i+3]:
            if FIELD.match(next_line):
                break
            name = valid_name(next_line)
            if name:
                return name
    return ""

def key_for(authority, ref):
    def clean(s):
        return re.sub("[^a-z0-9]", "", str(s or "").lower())
    return "planning|" + clean(authority) + "|" + clean(ref)

def check_recent(checked, key, days=30):
    try:
        return (dt.date.today() - dt.date.fromisoformat(checked[key])).days < days
    except (KeyError, ValueError):
        return False

def official_name(url):
    global site_visits
    if not official_url(url) or site_visits >= MAX_SITE_VISITS or time.monotonic() - started > MAX_RUN_SECONDS:
        return ""
    site_visits += 1
    try:
        return extract_applicant(get(url))
    except Exception as error:
        print("Unable to inspect source:", url[:90], str(error)[:120])
        return ""

def main():
    if not DATA.exists():
        raise RuntimeError("Missing seed file " + str(DATA))
    data = json.loads(DATA.read_text(encoding="utf-8"))
    records = data.setdefault("records", {})
    checked = data.setdefault("checked", {})
    stats = {"candidates": 0, "newApplicants": 0, "sourcePagesInspected": 0, "date": TODAY}
    cursor = data.setdefault("cursor", {"planning": 0, "acp": 0})
    # Only schemes of 25+ homes; no individual houses or small extensions.
    where = "NumResidentialUnits >= 25 AND (ApplicantForename IS NULL OR ApplicantForename = '' OR ApplicantSurname IS NULL OR ApplicantSurname = '')"
    try:
        planning = query(PLANNING, where,
            "PlanningAuthority,ApplicationNumber,ApplicantForename,ApplicantSurname,LinkAppDetails,NumResidentialUnits",
            450, "ReceivedDate DESC", cursor.get("planning", 0))
        # Advance only after every candidate in this batch has been checked.
    except Exception as error:
        print("Planning feed unavailable:", error)
        planning = []
    for row in planning:
        if site_visits >= MAX_PLANNING_VISITS or time.monotonic() - started > MAX_RUN_SECONDS:
            break
        authority, ref = row.get("PlanningAuthority"), row.get("ApplicationNumber")
        if not authority or not ref:
            continue
        key = key_for(authority, ref)
        stats["candidates"] += 1
        if records.get(key, {}).get("applicant") or check_recent(checked, key):
            continue
        checked[key] = TODAY
        url = row.get("LinkAppDetails") or ""
        name = official_name(url)
        if name:
            records.setdefault(key, {}).update({"applicant": name, "applicantSource": url,
                "applicantEvidence": "Applicant explicitly labelled on the linked planning-authority page",
                "verifiedAt": TODAY})
            stats["newApplicants"] += 1
            print("Verified", key, "from", url[:85])
    if planning and all(records.get(key_for(r.get("PlanningAuthority"), r.get("ApplicationNumber")), {}).get("applicant") or check_recent(checked, key_for(r.get("PlanningAuthority"), r.get("ApplicationNumber"))) or not r.get("LinkAppDetails") for r in planning):
        cursor["planning"] = 0 if len(planning) < 450 or cursor.get("planning", 0) >= 4500 else cursor.get("planning", 0) + 450
    # ACP LRD/SHD cases are joined to the originating local authority application
    # by exact authority + planning reference, never by site description alone.
    try:
        acp = query(ACP, "(CATEGORY LIKE '%LRD%' OR CATEGORY LIKE '%SHD%' OR CATEGORY LIKE '%Strategic Housing%')",
                    "ABPCASEID,LINKABPWEB,PLANINGATY,CATEGORY", 160, "LODGEDON DESC", cursor.get("acp", 0))
        # Advance only after this batch has been examined.
    except Exception as error:
        print("ACP feed unavailable:", error)
        acp = []
    acp_checks = 0
    for row in acp:
        if acp_checks >= MAX_ACP_CASES or site_visits >= MAX_SITE_VISITS or time.monotonic() - started > MAX_RUN_SECONDS:
            break
        case = re.search(r"\d{6}", str(row.get("ABPCASEID") or ""))
        if not case:
            continue
        caseid = case.group()
        key = "acp|" + caseid
        if records.get(key, {}).get("applicant") or check_recent(checked, key):
            continue
        checked[key] = TODAY
        acp_checks += 1
        url = row.get("LINKABPWEB") or ("https://www.pleanala.ie/en-ie/case/" + caseid)
        if not official_url(url):
            continue
        try:
            markup = get(url)
            # Commission case pages often omit applicant, but identify the
            # originating council application, which can carry that field.
            ref = re.search(r"Planning Authority Case Reference:\s*([A-Za-z0-9/.-]+)", TextToPlain(markup), re.I)
            authority = row.get("PLANINGATY") or ""
            if not ref or not authority:
                continue
            planning_key = key_for(authority, ref.group(1))
            known = records.get(planning_key, {})
            name = known.get("applicant", "")
            source = known.get("applicantSource", "")
            if not name:
                safe_ref = ref.group(1).replace("'", "''")
                safe_auth = str(authority).replace("'", "''")
                matches = query(PLANNING, "ApplicationNumber = '" + safe_ref + "' AND PlanningAuthority = '" + safe_auth + "'",
                                "ApplicantForename,ApplicantSurname,LinkAppDetails", 3)
                if len(matches) == 1:
                    match = matches[0]
                    name = valid_name(" ".join(filter(None, [match.get("ApplicantForename"), match.get("ApplicantSurname")])))
                    source = match.get("LinkAppDetails") or ""
                    if not name:
                        name = official_name(source)
            if name and source and official_url(source):
                records.setdefault(key, {}).update({"applicant": name, "applicantSource": source,
                    "applicantEvidence": "Matched ACP case to exact council application reference; applicant named in linked official record",
                    "planningReference": ref.group(1), "planningAuthority": authority, "verifiedAt": TODAY})
                stats["newApplicants"] += 1
        except Exception as error:
            print("ACP match skipped:", caseid, str(error)[:100])
    if acp and all(not re.search(r"\d{6}", str(r.get("ABPCASEID") or "")) or check_recent(checked, "acp|" + re.search(r"\d{6}", str(r.get("ABPCASEID") or "")).group()) or records.get("acp|" + re.search(r"\d{6}", str(r.get("ABPCASEID") or "")).group(), {}).get("applicant") for r in acp):
        cursor["acp"] = 0 if len(acp) < 160 or cursor.get("acp", 0) >= 3200 else cursor.get("acp", 0) + 160
    stats["sourcePagesInspected"] = site_visits
    stats["acpCasesInspected"] = acp_checks
    data["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
    data["stats"] = stats
    # Preserve manually verified developer/promoter records.
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(stats))

def TextToPlain(markup):
    parser = Text()
    parser.feed(markup)
    parser.flush()
    return "\n".join(parser.lines)

if __name__ == "__main__":
    main()
