#!/usr/bin/env python3
"""Source-backed applicant discovery in public council application-form PDFs.

Inspects only direct links found on the exact official council application page,
and at most one official document-list page linked from it. Applicant must be
explicitly labelled in a PDF; agents, architects, owners and developers are
never treated as applicants by implication. Scanned-image PDFs remain unresolved.
"""
import datetime as dt
import html
import importlib.util
import io
import json
import re
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote
from urllib.request import Request, urlopen

from pypdf import PdfReader

ROOT=Path("preview-r9/data")
CATALOGUE=ROOT/"major-schemes.json"
EVIDENCE=ROOT/"applicant-enrichment.json"
SOURCE=Path("preview-r9/scripts/enrich_applicants.py")
spec=importlib.util.spec_from_file_location("applicant_source",SOURCE)
base=importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
TODAY=dt.date.today().isoformat()
MAX_CASES=35
MAX_DOCUMENTS=35
MAX_SECONDS=100
MAX_PDF_BYTES=8_000_000
FORM_LABEL=re.compile(r"^(?:name\s+of\s+(?:the\s+)?applicant(?:\(s\))?|"
                      r"applicant(?:\(s\))?(?:['’]s)?\s+name|"
                      r"applicant\s+details\s*[-:]\s*name|"
                      r"full\s+name\s+of\s+(?:the\s+)?applicant(?:\(s\))?|"
                      r"name\(s\)\s+of\s+(?:the\s+)?applicant)\s*:?\s*(.*)$",re.I)
NOT_NAME=re.compile(r"\b(?:applicant\s+address|agent|architect|planning\s+consultant|"
                    r"landowner|owner|telephone|email|phone|signature|address|"
                    r"company\s+registration\s+number|please\s+state|please\s+print)\b",re.I)
FORM_HINT=re.compile(r"\b(?:application\s+form|planning\s+application\s+form|"
                     r"part\s*b\b|form\s*b\b|application\s+details)\b",re.I)
DOC_HINT=re.compile(r"\b(?:documents?|files?|view\s+application|"
                    r"application\s+documents|supporting\s+documents)\b",re.I)

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items=[]
        self.href=None
        self.text=[]
    def handle_starttag(self,tag,attrs):
        if tag=="a":
            self.href=dict(attrs).get("href")
            self.text=[]
    def handle_data(self,data):
        if self.href is not None:
            self.text.append(data)
    def handle_endtag(self,tag):
        if tag=="a" and self.href is not None:
            self.items.append((self.href," ".join(" ".join(self.text).split())))
            self.href=None
            self.text=[]

def valid_document_url(href,parent):
    try:
        u=urljoin(parent,html.unescape(href or ""))
        parsed=urlsplit(u)
        if parsed.scheme not in ("https","http") or parsed.username or parsed.password:
            return ""
        if not base.official_url(u):
            return ""
        # Do not fetch documents from a different host via arbitrary page links.
        host=(parsed.hostname or "").lower()
        original=(urlsplit(parent).hostname or "").lower()
        if host.removeprefix("www.")!=original.removeprefix("www."):
            return ""
        return u
    except Exception:
        return ""

def form_document_links(markup,parent):
    links=Links()
    links.feed(markup)
    found=[]
    for href,title in links.items:
        url=valid_document_url(href,parent)
        if not url:
            continue
        label=unquote(title+" "+href).replace("-"," ").replace("_"," ")
        if FORM_HINT.search(label) and (".pdf" in href.lower() or "download" in href.lower()):
            found.append(url)
    return list(dict.fromkeys(found))[:5]

def document_listing_links(markup,parent):
    links=Links()
    links.feed(markup)
    result=[]
    for href,title in links.items:
        url=valid_document_url(href,parent)
        if url and DOC_HINT.search(title+" "+href) and ".pdf" not in href.lower():
            result.append(url)
    return list(dict.fromkeys(result))[:2]

def extract_form_applicant(text):
    """Require a form field label; avoid generic references to 'the applicant'."""
    lines=[" ".join(x.split()).strip(" |•\t") for x in str(text or "").splitlines()]
    for i,line in enumerate(lines[:420]):
        match=FORM_LABEL.fullmatch(line)
        if not match:
            continue
        values=[match.group(1)]
        if not values[0]:
            values.extend(lines[i+1:i+4])
        for candidate in values:
            candidate=candidate.strip(" :.-_")
            if NOT_NAME.search(candidate) or re.search(r"\b(?:name\s+of|applicant\s+details)\b",candidate,re.I):
                break
            name=base.valid_name(candidate)
            if name:
                return name
    return ""

def fetch_bytes(url,max_bytes,accept,timeout=9):
    req=Request(url,headers={"User-Agent":base.UA,"Accept":accept})
    with urlopen(req,timeout=timeout) as response:
        target=response.url
        if not valid_document_url(target,url):
            raise ValueError("Document redirect outside council host")
        content=response.read(max_bytes+1)
    if len(content)>max_bytes:
        raise ValueError("Document exceeds extraction size limit")
    return content

def inspect_pdf(url):
    content=fetch_bytes(url,MAX_PDF_BYTES,"application/pdf",timeout=12)
    if not content.startswith(b"%PDF"):
        return ""
    pdf=PdfReader(io.BytesIO(content),strict=False)
    text="\n".join((page.extract_text() or "") for page in pdf.pages[:5])
    return extract_form_applicant(text)

def discover_form_links(source):
    page=fetch_bytes(source,1_000_000,"text/html",timeout=9).decode("utf-8","replace")
    links=form_document_links(page,source)
    if links:
        return links
    for listing in document_listing_links(page,source):
        try:
            listing_page=fetch_bytes(listing,1_000_000,"text/html",timeout=9).decode("utf-8","replace")
            links.extend(form_document_links(listing_page,listing))
        except Exception:
            continue
    return list(dict.fromkeys(links))[:5]

def main():
    catalogue=json.loads(CATALOGUE.read_text(encoding="utf-8"))
    evidence=json.loads(EVIDENCE.read_text(encoding="utf-8"))
    records=evidence.setdefault("records",{})
    checked=evidence.setdefault("councilFormChecked",{})
    candidates=[p for p in catalogue.get("projects",[])
                if p.get("kind")!="acp" and not p.get("applicant")
                and not records.get(p.get("key",""),{}).get("applicant")
                and base.official_url(p.get("source",""))
                and not p.get("sourceLinkType")]
    candidates.sort(key=lambda p:p.get("received",""),reverse=True)
    attempts=pdfs=found=linked=0
    started=time.monotonic()
    for p in candidates:
        if attempts>=MAX_CASES or pdfs>=MAX_DOCUMENTS or time.monotonic()-started>MAX_SECONDS:
            break
        identifier=p["key"]
        try:
            last=dt.date.fromisoformat(checked.get(identifier,""))
            if (dt.date.today()-last).days<30:
                continue
        except ValueError:
            pass
        checked[identifier]=TODAY
        attempts+=1
        try:
            urls=discover_form_links(p["source"])
            if urls:
                linked+=1
            for url in urls[:3]:
                if pdfs>=MAX_DOCUMENTS or time.monotonic()-started>MAX_SECONDS:
                    break
                pdfs+=1
                try:
                    name=inspect_pdf(url)
                    if not name:
                        continue
                    records.setdefault(identifier,{}).update({
                        "applicant":name,"applicantSource":url,
                        "applicantEvidence":"Explicit applicant-name field in official council application form PDF",
                        "verifiedAt":TODAY,
                    })
                    found+=1
                    print("Council application form verified",identifier,url[:140])
                    break
                except Exception as error:
                    print("Council PDF unavailable",identifier,str(error)[:95])
        except Exception as error:
            print("Council document listing unavailable",identifier,str(error)[:95])
    evidence["councilFormStats"]={
        "pagesCheckedThisRun":attempts,"pagesWithFormLinks":linked,
        "pdfsInspectedThisRun":pdfs,"applicantsVerifiedThisRun":found,
        "pagesCheckedTotal":len(checked),
        "updatedAt":dt.datetime.now(dt.timezone.utc).isoformat(),
        "note":"Only publicly linked PDF application forms; image-only documents need manual review."
    }
    EVIDENCE.write_text(json.dumps(evidence,ensure_ascii=False,indent=2,sort_keys=True)+"\n",encoding="utf-8")
    print(json.dumps(evidence["councilFormStats"]))

if __name__=="__main__":
    main()
