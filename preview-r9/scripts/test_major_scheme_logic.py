import importlib.util
from pathlib import Path

p=Path("preview-r9/scripts/major_scheme_logic.py")
spec=importlib.util.spec_from_file_location("logic",p)
logic=importlib.util.module_from_spec(spec)
spec.loader.exec_module(logic)
assert logic.extract_units("Development of 1,250 residential units and 400 car spaces")==1250
assert logic.extract_units("Construction of 346 no. residential units")==346
assert logic.extract_units("A site of 3.4ha with 89 dwellings")==0
assert logic.extract_units("150 parking spaces and 120 homes")==120
assert logic.scheme_type("Amendment to previously permitted SHD")=="Amendment / modification"
assert logic.scheme_type("Mixed-use residential-led development")=="Mixed-use residential"
assert logic.scheme_type("","SD16A/0210/FEP1")=="Extension of duration"
assert logic.scheme_type("Large-Scale Residential Development")=="Large-scale Residential Development"
assert "Citywest Road" in logic.site_name("Site at Citywest Road, Dublin 24","")
assert logic.site_name("","townland of Kilgobbin")=="Kilgobbin"
assert logic.project_url("javascript:alert(1)")==""
assert logic.project_url("","acp","324062").endswith("/324062")
assert logic.duplicate_key("Meath County Council","26/61080")==logic.duplicate_key("Meath County Council","2661080")
assert logic.site_name("Generic road", 'The development is known as "Marshallyards" and comprises 200 homes')=="Marshallyards"
assert logic.site_name("Lands at Galway Port", "", "Galway Port LRD")=="Galway Port LRD"
assert logic.brand_from_applicant("Glenveagh Homes Limited")=="Glenveagh"
assert logic.brand_from_applicant("Unrelated Special Purpose Vehicle Ltd")==""
print("Major-scheme site classification, unit extraction and identity tests passed")
