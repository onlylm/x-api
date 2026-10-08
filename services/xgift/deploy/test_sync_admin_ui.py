import importlib.util
from pathlib import Path, PurePosixPath
import unittest

spec = importlib.util.spec_from_file_location('sync_ui', Path(__file__).with_name('sync-admin-ui.py'))
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
OLD = '/opt/x-platform-orders/releases/' + 'a' * 40 + '/ui'
TARGET = PurePosixPath('/opt/xgift/releases/' + 'b' * 40 + '/services/xgift/dist')
ORIGINAL = ('location = / {\n    root ' + OLD + ';\n    try_files /index.html =404;\n}\n'
            'location = /index.html {\n    root ' + OLD + ';\n}\n'
            'location ^~ /platform-admin-ui/old/ {\n    alias ' + OLD + '/;\n}\n'
            'location = /api/admin/platform-orders {\n    proxy_pass http://127.0.0.1:3111;\n}\n')


class SyncUiTests(unittest.TestCase):
    def test_only_two_roots_change(self):
        result = ui.candidate(ORIGINAL, TARGET)
        self.assertEqual(result.replace('root ' + str(TARGET), 'root ' + OLD), ORIGINAL)
        self.assertIn('alias ' + OLD + '/;', result)
        self.assertIn('proxy_pass http://127.0.0.1:3111;', result)

    def test_next_x_release_supported(self):
        first = ui.candidate(ORIGINAL, TARGET)
        second = PurePosixPath(str(TARGET).replace('b' * 40, 'c' * 40))
        self.assertEqual(ui.candidate(first, second).count('root ' + str(second)), 2)

    def test_unexpected_targets_rejected(self):
        for value in ('/tmp/ui', '/opt/xgift/current/services/xgift/dist', str(TARGET) + '/../dist'):
            with self.assertRaises(RuntimeError):
                ui.candidate(ORIGINAL, Path(value))

    def test_missing_or_extra_root_rejected(self):
        for value in (ORIGINAL.replace('    root ' + OLD + ';', '', 1),
                      ORIGINAL + '\n    root ' + OLD + ';\n'):
            with self.assertRaises(RuntimeError):
                ui.candidate(value, TARGET)

    def test_api_root_cannot_be_replaced(self):
        invalid = ORIGINAL.replace('    root ' + OLD + ';', '', 1) + '\n    root ' + OLD + ';\n'
        with self.assertRaises(RuntimeError):
            ui.candidate(invalid, TARGET)

    def test_nonmatching_roots_rejected(self):
        with self.assertRaises(RuntimeError):
            ui.candidate(ORIGINAL.replace('a' * 40, 'c' * 40, 1), TARGET)

    def test_assets_validate_build(self):
        html = b'<link href="/favicon.svg"><script src="/assets/main-abc.js"></script><link href="/assets/main.css">'
        self.assertEqual(ui.assets(html), ['/favicon.svg', '/assets/main-abc.js', '/assets/main.css'])

    def test_unsafe_or_incomplete_assets_rejected(self):
        for url in ('https://evil.test/a.js', '/assets/../main.js', '/assets/main.js?key=x', ''):
            with self.assertRaises(RuntimeError):
                ui.assets(('<script src="' + url + '"></script><link href="/assets/main.css">').encode())
        with self.assertRaises(RuntimeError):
            ui.assets(b'<script src="/assets/main.js"></script>')


if __name__ == '__main__':
    unittest.main()
