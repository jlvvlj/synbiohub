import requests
from unittest import TestCase
from test_functions import compare_get_request, compare_post_request

class TestFeatures(TestCase):

    def test_advancedSearch(self):
        compare_get_request("/advancedSearch")

    def test_resetPassword(self):
        compare_get_request("/resetPassword")

    def test_browse(self):
        compare_get_request("/browse")
