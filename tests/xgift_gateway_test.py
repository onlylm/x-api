"""Offline tests for the fixed-egress card-management allowlist."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

os.environ['GATEWAY_SECRET'] = 'offline-test-secret-1234567890123456'
spec = importlib.util.spec_from_file_location('gateway', Path(__file__).parents[1] / 'services/xgift/gateway.py')
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class CardGatewayTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop('CARD_WRITES_ENABLED', None)

    def request(self, url, method='GET', body=''):
        return gateway.card_target({'url': url, 'method': method, 'body': body, 'headers': {
            'X-API-Key': 'sk_offline_test', 'Idempotency-Key': 'cop_offline_test', 'Cookie': 'must_not_forward'}})

    def test_fixed_targets_and_header_filter(self):
        for suffix in ['/balance', '/products', '/cards?page=1&page_size=30&sync=0', '/cards/123/transactions', '/cards/123/recharges']:
            request = self.request('https://sandbox.zovocard.com/openapi/v1' + suffix)
            self.assertEqual(request.method, 'GET')
            self.assertNotIn('Cookie', dict(request.header_items()))

    def test_empty_query_skips_strict_parser_on_all_python_versions(self):
        # Python 3.10 rejects an empty query under strict parsing. Empty queries
        # contain no fields, so do not pass them to the version-sensitive parser.
        with patch.object(gateway.urllib.parse, 'parse_qs', side_effect=ValueError('empty query')) as parser:
            for suffix in ['/balance', '/products', '/cards', '/cards?', '/cards/123/transactions', '/cards/123/recharges']:
                with self.subTest(suffix=suffix):
                    self.assertEqual(self.request('https://zovocard.com/openapi/v1' + suffix).method, 'GET')
            os.environ['CARD_WRITES_ENABLED'] = 'true'
            self.assertEqual(self.request('https://zovocard.com/openapi/v1/cards/recharge', 'POST', '{}').method, 'POST')
            parser.assert_not_called()

    def test_nonempty_query_stays_strict(self):
        for query in ['page', 'page=1&', '&page=1', 'page=1&&sync=0', 'page=',
                      'page=1&page=2', 'sync=1', 'sync', 'unknown=1']:
            with self.subTest(query=query), self.assertRaises(ValueError):
                self.request('https://zovocard.com/openapi/v1/cards?' + query)
        self.assertEqual(self.request('https://zovocard.com/openapi/v1/cards?page=2&page_size=30&sync=0').method, 'GET')

    def test_rejects_arbitrary_destinations_and_sensitive_card_details(self):
        for url in ['http://zovocard.com/openapi/v1/balance', 'https://evil.test/openapi/v1/balance',
                    'https://zovocard.com/openapi/v1/cards/123', 'https://zovocard.com/openapi/v1/cards?sync=1',
                    'https://zovocard.com/openapi/v1/cards?x=http', 'https://zovocard.com/openapi/v1/cards/open',
                    'https://zovocard.com/openapi/v1/balance#frag', 'https://zovocard.com:444/openapi/v1/balance']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.request(url)

    def test_writes_require_independent_server_switch(self):
        target = 'https://zovocard.com/openapi/v1/cards/recharge'
        with self.assertRaises(ValueError):
            self.request(target, 'POST', '{}')
        os.environ['CARD_WRITES_ENABLED'] = 'true'
        self.assertEqual(self.request(target, 'POST', '{"card_id":123,"amount":20}').method, 'POST')
        with self.assertRaises(ValueError):
            self.request('https://zovocard.com/openapi/v1/cards/refund', 'POST', '{}')


if __name__ == '__main__':
    unittest.main()
