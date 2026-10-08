import importlib.util
spec=importlib.util.spec_from_file_location("acp", "preview-r10/scripts/enrich_acp_reports.py")
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
sample="""Inspector's Report
ABP-321437-24
Development
Construction of 197 residential units
Location
Clonard or Folkstown Great
Planning Authority
Fingal County Council
Applicant
Marshall Yards Development Co. Ltd.
Type of Application
Large-Scale Residential Development
"""
assert mod.extract_applicant(sample)=="Marshall Yards Development Co. Ltd"
assert mod.extract_applicant("Applicant\nDevelopment Description\nAppellant\nJohn Smith")==""
assert mod.extract_applicant("Appellant\nMarshall Yards Development Co. Ltd.")==""
assert mod.report_url("321437").endswith("/321/r321437.pdf")
assert mod.report_url("javascript:alert(1)")==""
assert mod.extract_case_applicant("<h2>Parties</h2><ul><li>Marshall Yards Development Company Ltd (Applicant)</li><li>Jane Doe (3rd Party Appellant)</li></ul><h2>History</h2>")=="Marshall Yards Development Company Ltd"
assert mod.extract_case_applicant("<h2>Parties</h2><li>John Smith (1st Party Appellant)</li>")==""
assert mod.extract_case_applicant("<h2>History</h2><li>John Smith (Applicant)</li>")==""
print("ACP official case-party and inspector-report applicant extraction tests passed")
