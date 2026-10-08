#!/usr/bin/env python3
"""Incremental, source-backed ACP applicant enrichment from official inspector reports.

Only an explicitly labelled Applicant field is accepted. Appellants, observers,
agents and developers are never substituted for the planning applicant.
"""
import datetime as dt
import io
import json
import re
import time
from pathlib import Path
from urllib.request import Request, urlopen

from pypdf import PdfReader

ROOT=Path("preview-r9/data")
CATALOGUE=ROOT/"major-schemes.json"
EVIDENCE=ROOT/"applicant-enrichment.json"
TODAY=dt.date.today().isoformat()
MAX_CASES=65
MAX_SECONDS=165

def report_url(case_id):
    if not re.fullmatch(r"\d{6}",str(case_id or "")):
        return ""
    return ("https://www.pleanala.ie/anbordpleanala/media/abp/cases/reports/"
            +str(case_id)[:3]+"/r"+str(case_id)+".pdf")

def extract_applicant(text):
    """Accept only a clearly labelled name in the report's cover-sheet block."""
    raw=str(text or "")[:6500]
    lines=[" ".join(x.split()).strip(" :|") for x in raw.splitlines()]
    invalid=re.compile(r"\b(?:development description|planning authority|decision|appellant|observer|report|inspector|location|type of application|case reference|appeal|planning register|site area)\b",re.I)
    for i,line in enumerate(lines[:105]):
        match=re.fullmatch(r"(?:Applicant(?:'s)?(?: Name)?)(?:\s*:\s*(.*))?",line,re.I)
        if match:
            candidate=(match.group(1) or "").strip()
            if not candidate:
                candidate=next((x for x in lines[i+1:i+4] if x), "")
            if 4<=len(candidate)<=105 and not invalid.search(candidate):
                if re.fullmatch(r"[A-Za-z0-9][\w\s&'’.,()/+-]+",candidate) and len(candidate.split())>=2:
                    return candidate.strip(" .")
    return ""

def fetch_report(case_id):
    url=report_url(case_id)
    req=Request(url,headers={"User-Agent":"Radharc Pleanála public planning research (contact via GitHub repository)","Accept":"application/pdf"})
    with urlopen(req,timeout=5) as response:
        content=response.read(7_500_001)
    if len(content)>7_500_000 or not content.startswith(b"%PDF"):
        return ""
    reader=PdfReader(io.BytesIO(content),strict=False)
    text="\n".join((page.extract_text() or "") for page in reader.pages[:2])
    return extract_applicant(text)

def main():
    catalogue=json.loads(CATALOGUE.read_text(encoding="utf-8"))
    evidence=json.loads(EVIDENCE.read_text(encoding="utf-8"))
    records=evidence.setdefault("records",{})
    checked=evidence.setdefault("acpReportChecked",{})
    candidates=[p for p in catalogue.get("projects",[]) if p.get("kind")=="acp" and
                not p.get("applicant") and not records.get(p.get("key",""),{}).get("applicant")]
    # Older, decided cases are more likely to have published inspector reports.
    candidates.sort(key=lambda p:(not bool(p.get("decision")),p.get("received","")))
    started=time.monotonic()
    attempts=found=0
    for p in candidates:
        if attempts>=MAX_CASES or time.monotonic()-started>MAX_SECONDS:
            break
        key=p["key"]
        if checked.get(key):
            continue
        case=p.get("caseId") or p.get("reference")
        if not report_url(case):
            continue
        checked[key]=TODAY
        attempts+=1
        try:
            name=fetch_report(case)
            if not name:
                continue
            source=report_url(case)
            records.setdefault(key,{}).update({
                "applicant":name,"applicantSource":source,
                "applicantEvidence":"Explicit Applicant field in the official ACP Inspector's Report",
                "verifiedAt":TODAY,
            })
            found+=1
        except Exception as exc:
            print("ACP report unavailable:",case,str(exc)[:95])
    evidence["acpReportStats"]={"attemptedThisRun":attempts,"namesFoundThisRun":found,
                                 "reportsCheckedTotal":len(checked),"updatedAt":dt.datetime.now(dt.timezone.utc).isoformat()}
    EVIDENCE.write_text(json.dumps(evidence,ensure_ascii=False,indent=2,sort_keys=True)+"\n",encoding="utf-8")
    print(json.dumps(evidence["acpReportStats"]))

if __name__=="__main__":
    main()
