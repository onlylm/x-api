"""Offline-only tests for the isolated Quefa Caddy relay."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_caddy', Path(__file__).with_name('deploy-caddy-route.py'))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

BASELINE = '''api.quefa.cn {
  encode zstd gzip
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }
  route {
    @legacy_admin path /admin/api/test/* /admin/api/manual-orders /admin/api/manual-orders/* /admin/api/orders/*/refresh-payment
    handle @legacy_admin {
      reverse_proxy app_cdk_guard:3100
    }
    @finance_admin path /admin /admin/*
    handle @finance_admin {
      reverse_proxy app_finance:3100
    }
    handle {
      reverse_proxy app_cdk_guard:3100
    }
  }
  log {
    output file /var/log/caddy/access.log {
      roll_size 10MiB
      roll_keep 10
      roll_keep_for 720h
    }
    format json
  }
}
other.example {
  reverse_proxy elsewhere:80
}
'''


class CaddyGuards(unittest.TestCase):
    def test_only_inserts_new_handle_and_preserves_all_old_bytes(self):
        candidate = deploy.make_candidate(BASELINE)
        nested = ''.join('  ' + line if line.strip() else line
                         for line in deploy.INSERTION.splitlines(keepends=True))
        self.assertEqual(candidate.replace(nested, ''), BASELINE)
        self.assertIn('  route {\n' + nested + '    @legacy_admin', candidate)
        self.assertLess(candidate.index('handle /bluev/*'), candidate.index('handle @legacy_admin'))
        self.assertLess(candidate.index('handle /bluev/*'), candidate.index('handle @finance_admin'))
        self.assertLess(candidate.index('handle /bluev/*'), candidate.index('    handle {'))

    def test_does_not_insert_at_site_level_before_existing_route(self):
        candidate = deploy.make_candidate(BASELINE)
        self.assertLess(candidate.index('  route {'), candidate.index('handle /bluev/*'))
        self.assertEqual(candidate.split('  route {', 1)[0], BASELINE.split('  route {', 1)[0])

    def test_missing_or_multiple_legacy_route_blocks_are_rejected(self):
        for text in (BASELINE.replace('  route {', '  handle {'), BASELINE + 'later.example {\n  route {\n  }\n}\n'):
            with self.subTest(text=text), self.assertRaisesRegex(deploy.RouteError, 'route_missing_or_ambiguous'):
                deploy.make_candidate(text)

    def test_other_hosts_are_not_changed(self):
        candidate = deploy.make_candidate(BASELINE)
        self.assertEqual(candidate.split('other.example', 1)[1], BASELINE.split('other.example', 1)[1])

    def test_missing_or_ambiguous_api_host_is_rejected(self):
        for text in ('other.example {\n}\n', BASELINE + 'api.quefa.cn {\n}\n'):
            with self.subTest(text=text), self.assertRaisesRegex(deploy.RouteError, 'ambiguous'):
                deploy.make_candidate(text)

    def test_second_mapping_is_rejected(self):
        with self.assertRaisesRegex(deploy.RouteError, 'already_present'):
            deploy.make_candidate(deploy.make_candidate(BASELINE))

    def test_route_has_explicit_rewrite_order_and_preserves_query_placeholder(self):
        text = deploy.INSERTION
        self.assertLess(text.index('route {'), text.index('uri strip_prefix /bluev'))
        self.assertLess(text.index('uri strip_prefix /bluev'), text.index('rewrite * /partner{uri}'))
        self.assertLess(text.index('rewrite * /partner{uri}'), text.index('reverse_proxy'))

    def test_verified_https_upstream_and_host_only(self):
        self.assertIn('reverse_proxy https://x.aifu.me', deploy.INSERTION)
        self.assertIn('header_up Host x.aifu.me', deploy.INSERTION)
        self.assertNotIn('tls_insecure_skip_verify', deploy.INSERTION)
        self.assertNotIn('header_up X-API-Key', deploy.INSERTION)

    def test_adapt_validate_and_reload_only_execute_on_caddy(self):
        with patch.object(deploy, 'run', return_value='{}') as run:
            deploy.adapt_validate('candidate')
            self.assertEqual(run.call_args.args[0][:5], ['docker', 'exec', '-i', deploy.CADDY, 'caddy'])
            self.assertIn('--validate', run.call_args.args[0])
            deploy.reload_config('candidate')
            self.assertEqual(run.call_args.args[0][4:6], ['caddy', 'reload'])
            self.assertEqual(run.call_args.kwargs['input_text'], 'candidate')

    def test_json_hash_ignores_dictionary_key_order(self):
        self.assertEqual(deploy.canonical_sha({'a': 1, 'b': 2}), deploy.canonical_sha({'b': 2, 'a': 1}))
        self.assertNotEqual(deploy.canonical_sha({'a': [1, 2]}), deploy.canonical_sha({'a': [2, 1]}))

    def test_concurrent_file_change_stops_rollback_before_any_write_or_reload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            caddy = root / 'Caddyfile'
            compose = root / 'compose.yaml'
            caddy.write_text('concurrent')
            compose.write_text('unchanged')
            state = {'containers': {'caddy': 'locked'}, 'compose_sha256': deploy.sha(b'unchanged'),
                     'original_sha256': 'old', 'candidate_sha256': 'new'}
            with patch.multiple(deploy, CADDYFILE=caddy, COMPOSE=compose), patch.object(deploy, 'containers', return_value={'caddy': 'locked'}), patch.object(deploy, 'active_config_sha', return_value='old-runtime'), patch.object(deploy, 'update_bound_file') as write, patch.object(deploy, 'reload_config') as reload:
                with self.assertRaisesRegex(deploy.RouteError, 'concurrent_file'):
                    deploy.rollback_after_failure(state)
                write.assert_not_called()
                reload.assert_not_called()

    def test_changed_container_stops_rollback(self):
        with patch.object(deploy, 'containers', return_value={'caddy': 'new'}), patch.object(deploy, 'update_bound_file') as write:
            with self.assertRaisesRegex(deploy.RouteError, 'container_identity'):
                deploy.rollback_after_failure({'containers': {'caddy': 'old'}})
            write.assert_not_called()

    def test_script_contains_no_database_access_or_container_restart(self):
        code = deploy.SCRIPT.read_text()
        self.assertNotIn('import sqlite', code)
        self.assertNotIn("['docker', 'restart'", code)
        self.assertNotIn("['docker', 'compose'", code)
        self.assertNotIn("['systemctl'", code)


if __name__ == '__main__':
    unittest.main()
