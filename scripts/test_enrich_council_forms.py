import importlib.util
spec=importlib.util.spec_from_file_location("forms","preview-r10/scripts/enrich_council_forms.py")
mod=importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

assert mod.extract_form_applicant("APPLICATION FORM\nName of Applicant: Glenveagh Homes Limited\nName of Agent: Test Consultant")=="Glenveagh Homes Limited"
assert mod.extract_form_applicant("Part B\nApplicant Name\nMarshall Yards Development Company Limited\nApplicant Address\nLimerick")=="Marshall Yards Development Company Limited"
assert mod.extract_form_applicant("Name of Applicant\nAgent's Name\nABC Consultants Ltd")==""
assert mod.extract_form_applicant("The applicant wishes to apply for 200 homes")==""
assert mod.extract_form_applicant("Name of Applicant\nApplicant's Address\nMain Street")==""
html='<a href="/planning/files/Application%20Form%20Part%20B.pdf">Application Form Part B</a><a href="/other.pdf">Other Document</a>'
links=mod.form_document_links(html,"https://www.eplanning.ie/MeathCC/AppFileRefDetails/2561231/0")
assert len(links)==1 and links[0].endswith("Application%20Form%20Part%20B.pdf")
assert mod.valid_document_url("https://evil.example/doc.pdf","https://www.eplanning.ie/MeathCC/")== ""
assert mod.valid_document_url("javascript:alert(1)","https://www.eplanning.ie/MeathCC/")== ""
print("Official council form applicant extraction, link and safety tests passed")
