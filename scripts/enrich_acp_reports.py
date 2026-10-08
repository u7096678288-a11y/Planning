#!/usr/bin/env python3
"""Incremental, source-backed ACP applicant enrichment from official inspector reports.

Only an explicitly labelled Applicant field is accepted. Appellants, observers,
agents and developers are never substituted for the planning applicant.
"""
import datetime as dt
import io
import html
from html.parser import HTMLParser
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
MAX_CASES=45
MAX_SECONDS=115

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

class _ACPText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts=[]
        self.suppressed=0
    def handle_starttag(self,tag,attrs):
        if tag in ("script","style","noscript"):
            self.suppressed+=1
        if tag in ("li","p","div","h2","h3","br","td","tr"):
            self.parts.append("\n")
    def handle_endtag(self,tag):
        if tag in ("script","style","noscript"):
            self.suppressed=max(0,self.suppressed-1)
        if tag in ("li","p","div","h2","h3","td","tr"):
            self.parts.append("\n")
    def handle_data(self,data):
        if not self.suppressed:
            self.parts.append(html.unescape(data))

def extract_case_applicant(markup):
    """ACP's explicit 'Parties: <name> (Applicant)' only; not appellants."""
    parser=_ACPText()
    parser.feed(str(markup or ""))
    text="\n".join(" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    section=re.search(r"\bParties\b(.*?)(?:\bHistory\b|\bDocuments\b|$)",text,re.I|re.S)
    if not section:
        return ""
    candidates=re.findall(r"([^\n()]{4,130})\s*\(\s*Applicant\s*\)",section.group(1),re.I)
    for candidate in candidates:
        name=" ".join(candidate.split()).strip(" •:-")
        if 4<=len(name)<=115 and len(name.split())>=2 and not re.search(
                r"\b(?:Appellant|Observer|Agent|Representative|Party)\b",name,re.I):
            return name
    return ""

def fetch_case_applicant(case_id):
    url="https://www.pleanala.ie/en-ie/case/"+str(case_id)
    req=Request(url,headers={"User-Agent":"RadharcPleanalaApplicantEnrichment/1.0","Accept":"text/html"})
    with urlopen(req,timeout=6) as response:
        if not response.url.startswith(("https://www.pleanala.ie/","https://pleanala.ie/")):
            return ""
        markup=response.read(900_000).decode("utf-8","replace")
    return extract_case_applicant(markup)

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
        name=""
        source=""
        evidence_text=""
        try:
            name=fetch_case_applicant(case)
            if name:
                source="https://www.pleanala.ie/en-ie/case/"+str(case)
                evidence_text="Explicit Applicant party on official ACP case page"
        except Exception as exc:
            print("ACP case page unavailable:",case,str(exc)[:90])
        if not name:
            try:
                name=fetch_report(case)
                if name:
                    source=report_url(case)
                    evidence_text="Explicit Applicant field in the official ACP Inspector's Report"
            except Exception as exc:
                print("ACP inspector report unavailable:",case,str(exc)[:95])
        if name and source:
            records.setdefault(key,{}).update({
                "applicant":name,"applicantSource":source,
                "applicantEvidence":evidence_text,"verifiedAt":TODAY,
            })
            found+=1
    evidence["acpReportStats"]={"attemptedThisRun":attempts,"namesFoundThisRun":found,
                                 "reportsCheckedTotal":len(checked),"updatedAt":dt.datetime.now(dt.timezone.utc).isoformat()}
    EVIDENCE.write_text(json.dumps(evidence,ensure_ascii=False,indent=2,sort_keys=True)+"\n",encoding="utf-8")
    print(json.dumps(evidence["acpReportStats"]))

if __name__=="__main__":
    main()
