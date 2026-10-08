import importlib.util
import unittest

spec = importlib.util.spec_from_file_location("enrich", "preview-r6/scripts/enrich_applicants.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class ApplicantExtractionTests(unittest.TestCase):
    def test_navigation_is_not_an_applicant(self):
        self.assertEqual(mod.extract_applicant("<nav><div>Applicant</div><div>Development</div></nav>"), "")
    def test_explicit_council_applicant(self):
        self.assertEqual(mod.extract_applicant("<table><tr><th>Applicant Name</th><td>Cairn Homes Properties Limited</td></tr></table>"), "Cairn Homes Properties Limited")
    def test_company_with_development_in_name(self):
        self.assertEqual(mod.extract_applicant("<dl><dt>Applicant Name</dt><dd>Land Development Agency</dd></dl>"), "Land Development Agency")
    def test_reject_unstructured_single_word(self):
        self.assertEqual(mod.extract_applicant("<div>Applicant Name</div><div>Development</div>"), "")
    def test_source_domains(self):
        self.assertTrue(mod.official_url("https://eplanning.ie/LimerickCCC/AppFileRefDetails/2660396/0"))
        self.assertFalse(mod.official_url("http://localhost/private"))
        self.assertFalse(mod.official_url("https://example.com/case"))

if __name__ == "__main__":
    unittest.main()
