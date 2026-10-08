"""Conservative categorisation and deduplication for major residential schemes."""
import re
from urllib.parse import urlsplit

def compact(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())

def scheme_type(description="", reference="", category=""):
    text = " ".join(str(x or "") for x in (description, reference, category)).lower()
    if re.search(r"\b(?:extension of duration|extend(?:ing)? the duration|extension of time|ext(?:ension)?\s+of\s+duration|fep\d*)\b", text):
        return "Extension of duration"
    if re.search(r"\b(?:amendments?|modifications?|alterations?|revisions? to (?:a )?(?:previously|existing)|change of house type|material contravention|section 146b|s\.?146b)\b", text):
        return "Amendment / modification"
    if re.search(r"\b(?:mixed[\s-]?use|residential[\s-]?led|commercial and residential)\b", text):
        return "Mixed-use residential"
    if re.search(r"\b(?:strategic housing development|shd)\b", text):
        return "Strategic Housing Development"
    if re.search(r"\b(?:large[\s-]?scale residential development|large residential development|lrd)\b", text):
        return "Large-scale Residential Development"
    return "Residential development"

def extract_units(description):
    """Only explicit unit/dwelling/home counts, never floor areas or parking."""
    text = re.sub(r"\s+", " ", str(description or ""))
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", text)
    patterns = [
        r"\b(?:total of|comprising|consisting of|provision of|construction of|development of|up to|approximately|approx\.?)\s+(?:a\s+)?(\d{3,5})(?:\s*no\.?)?\s+(?:residential\s+)?(?:units|dwellings|homes|houses|apartments)\b",
        r"\b(\d{3,5})\s*(?:no\.?\s*)?(?:new\s+)?(?:residential\s+)?(?:units|dwellings|homes|houses|apartments)\b",
        r"\b(?:residential\s+)?(?:units|dwellings|homes)\s*(?:totalling|total(?:ling)?|of|:)\s*(\d{3,5})\b",
    ]
    counts=[]
    for pattern in patterns:
        for m in re.finditer(pattern,text,re.I):
            n=int(m.group(1))
            if 100<n<=20000: counts.append(n)
    return max(counts) if counts else 0

def site_name(address="", description="", project_website_name=""):
    """Use documented scheme title or the actual address/townland; never invent a brand."""
    title=" ".join(str(project_website_name or "").split())
    if title and 4<=len(title)<=95 and not re.search(r"^(?:planning|application|home|welcome|eplan|an coimisi|an bord)",title,re.I):
        return title
    desc=" ".join(str(description or "").split())
    named=re.search(r"\b(?:known as|to be called|scheme named|development named)\s+[\"'“‘]([^\"'”’]{4,85})[\"'”’]",desc,re.I)
    if named:
        return named.group(1).strip()
    addr=" ".join(str(address or "").split()).strip(" ,.;")
    desc=" ".join(str(description or "").split())
    if not addr:
        town=re.search(r"\btownland of ([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+){0,3})",desc)
        if town: return town.group(1)
        return "Residential scheme (location unconfirmed)"
    # Strip planning boilerplate but retain meaningful townland and road names.
    addr=re.sub(r"^(?:site\s+of\s+(?:approximately|approx\.?|c\.?|circa)\s*[\d.]+\s*(?:ha|hectares?)\s+at)\s+", "", addr, flags=re.I)
    addr=re.sub(r"^(?:site\s+at|lands?\s+(?:at|on|in|located at|situated at)|the\s+site\s+at|site\s+of)\s+", "", addr, flags=re.I)
    addr=re.sub(r"^(?:lands?\s+)?(?:generally\s+)?bounded by\s+", "",addr,flags=re.I)
    addr=re.sub(r"^(?:the\s+)?(?:former|existing)\s+", "",addr,flags=re.I)
    pieces=[p.strip(" ,.;") for p in addr.split(",") if p.strip(" ,.;")]
    if not pieces: return "Residential scheme (location unconfirmed)"
    # The first two components are generally a road/townland and settlement.
    title=", ".join(pieces[:2])
    if len(title)>88:
        title=pieces[0][:88].rsplit(" ",1)[0] if len(pieces[0])>88 else title[:88]
    return title or "Residential scheme (location unconfirmed)"

def project_url(raw, kind="", case_id=""):
    value=str(raw or "").strip()
    try:
        parsed=urlsplit(value)
        if parsed.scheme in ("https","http") and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    if kind=="acp":
        digits=re.search(r"\d{6}",str(case_id or ""))
        if digits: return "https://www.pleanala.ie/en-ie/case/"+digits.group()
    return ""

def duplicate_key(authority, reference):
    return compact(authority)+"|"+compact(reference)

def group_name(name):
    name=" ".join(str(name or "").replace("."," ").replace(","," ").split()).strip()
    return re.sub(r"\s+(?:limited|ltd|dac|designated activity company)\s*$","",name,flags=re.I).strip()

# Only surface a brand when the verified legal applicant actually contains
# that brand. Never infer ownership of differently named SPVs.
KNOWN_BRANDS = (
    ("Glenveagh", r"\bglenveagh\b"),
    ("Marshall Yards", r"\bmarshall?\s*yards\b"),
    ("Cairn", r"\bcairn\b"),
    ("Land Development Agency", r"\bland development agency\b|\blda\b"),
    ("Ballymore", r"\bballymore\b"),
    ("Marlet", r"\bmarlet\b"),
    ("Quintain", r"\bquintain\b"),
    ("Castlethorn", r"\bcastlethorn\b"),
    ("Lioncor", r"\blioncor\b"),
    ("Hines", r"\bhines\b"),
    ("Durkan", r"\bdurkan\b"),
    ("O'Flynn", r"\bo['’]?flynn\b"),
)
def brand_from_applicant(name):
    for brand, pattern in KNOWN_BRANDS:
        if re.search(pattern, str(name or ""), re.I):
            return brand
    return ""

def planning_route(description="", category=""):
    text=(str(description or "")+" "+str(category or "")).lower()
    if re.search(r"\blrd\b|large[\s-]?scale residential development",text):
        return "LRD"
    if re.search(r"\bshd\b|strategic housing development",text):
        return "SHD"
    if re.search(r"\bsdz\b|strategic development zone",text):
        return "SDZ"
    return ""
