"""Offline tests. No Docker daemon, systemd, production host or payment access."""
import copy
import importlib.util
import io
import json
import os
import sqlite3
from pathlib import Path
import sys
import tarfile
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bluev_deploy_common as common
spec = importlib.util.spec_from_file_location('bluev_test_upgrade', HERE / 'upgrade-bluev-test.py')
up = importlib.util.module_from_spec(spec)
spec.loader.exec_module(up)
OLD, NEW = 'a' * 40, 'b' * 40
OLD_ID, NEW_ID = 'c' * 64, 'd' * 64
IMAGE = 'sha256:' + 'e' * 64
NETWORK = 'merchant-gateway_gateway'


def state_fixture(role='console'):
    return {'role': role, 'from_sha': OLD, 'to_sha': NEW, 'status': 'prepared',
            'release': '/opt/bluev-test-console/releases/' + NEW,
            'old_release': '/opt/bluev-test-console/releases/' + OLD,
            'image': IMAGE, 'network': NETWORK, 'old_container_id': OLD_ID,
            'candidate_name': up.NAME + '-candidate-' + NEW[:12],
            'backup_name': up.NAME + '-backup-' + NEW[:12],
            'failed_name': up.NAME + '-failed-' + NEW[:12],
            'container_env_sha': common.canonical(['NODE_ENV=production'])}


def container(state, new=False, name=None):
    return {'Id': NEW_ID if new else OLD_ID, 'Image': IMAGE, 'Name': '/' + (name or up.NAME),
            'Config': {'Labels': {'bluev.release': NEW if new else OLD}, 'User': '1000:1000',
                       'WorkingDir': '/app', 'Entrypoint': ['node'], 'Cmd': ['dist/bluev-test-console-server.js'],
                       'Env': ['NODE_ENV=production']},
            'State': {'Running': not new, 'StartedAt': 'test-only'},
            'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'PortBindings': {},
                           'NetworkMode': NETWORK, 'CapDrop': ['ALL']},
            'Mounts': [{'Type': 'bind', 'Source': state['release'] if new else state['old_release'],
                        'Destination': '/app', 'RW': False}],
            'NetworkSettings': {'Networks': {NETWORK: {'Aliases': [name or up.NAME]}}}}


class FakeDocker:
    def __init__(self, state):
        self.state = state
        self.values = {OLD_ID: container(state)}
        self.calls = []
        self.fail_once = None

    def inspect(self, target):
        if target in self.values:
            return copy.deepcopy(self.values[target])
        for value in self.values.values():
            if value['Name'] == '/' + target:
                return copy.deepcopy(value)
        raise common.DeployError('not_found')

    def run(self, args, **kwargs):
        self.calls.append(args)
        if self.fail_once and self.fail_once(args):
            self.fail_once = None
            raise common.DeployError('injected_failure')
        if args[:3] == ['docker', 'ps', '-a']:
            return '\n'.join(value['Name'].removeprefix('/') for value in self.values.values())
        if args[:2] == ['docker', 'create']:
            self.values[NEW_ID] = container(self.state, True, args[3])
            return NEW_ID + '\n'
        if args[:2] == ['docker', 'exec']:
            return json.dumps({'status': 200, 'body': {'ok': True, 'service': up.NAME}})
        if args[:2] in (['docker', 'start'], ['docker', 'stop']):
            self.values[args[-1]]['State']['Running'] = args[1] == 'start'
            return ''
        if args[:3] == ['docker', 'network', 'disconnect']:
            self.values[args[-1]]['NetworkSettings']['Networks'].pop(args[-2], None)
            return ''
        if args[:3] == ['docker', 'network', 'connect']:
            self.values[args[-1]]['NetworkSettings']['Networks'][args[-2]] = {'Aliases': [up.NAME]}
            return ''
        if args[:2] == ['docker', 'rename']:
            self.values[args[2]]['Name'] = '/' + args[3]
            return ''
        raise AssertionError('unexpected command: ' + repr(args))


class ValidationTests(unittest.TestCase):
    def test_revisions_are_full_commit_ids(self):
        self.assertEqual(up.revision(NEW), NEW)
        for value in ('main', 'b' * 12, '../etc', NEW.upper(), None):
            with self.subTest(value=value), self.assertRaises(common.DeployError):
                up.revision(value)

    def test_only_two_fixed_roles(self):
        with self.assertRaisesRegex(common.DeployError, 'invalid_role'):
            up.legacy('finance')

    def test_actual_role_targets_are_fixed(self):
        self.assertEqual(up.legacy('x').ROOT.as_posix(), '/opt/x-bluev-sandbox')
        self.assertEqual(up.legacy('console').ROOT.as_posix(), '/opt/bluev-test-console')
        self.assertEqual(up.legacy('console').NAME, up.NAME)

    def test_separate_state_never_points_at_install_state(self):
        self.assertEqual(up.state_path('x', NEW), Path('/opt/x-bluev-sandbox/upgrades') / (NEW + '.json'))
        self.assertNotEqual(up.state_path('console', NEW), up.legacy('console').STATE)

    def test_no_delete_restore_or_proxy_mutation_in_source(self):
        source = (HERE / 'upgrade-bluev-test.py').read_text(encoding='utf-8')
        for forbidden in ("['docker', 'rm'", "['docker', 'compose'", "['systemctl', 'daemon-reload'",
                          "['systemctl', 'reload'", '.unlink(', 'rmtree(', 'copyfile(', 'copy2(',
                          'update_bound_file(', 'atomic(mod.SITE', 'save(mod.STATE'):
            self.assertNotIn(forbidden, source)
        self.assertIn("run(['systemctl', 'restart', SERVICE]", source)

    def test_database_identity_not_content_hash_and_survives_content_change(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'database'
            path.write_bytes(b'one')
            identity = up.db_identity(path)
            path.write_bytes(b'legitimate worker update')
            self.assertEqual(up.db_identity(path), identity)
            with self.assertRaises(common.DeployError):
                up.db_identity(Path(directory))

    def test_manifest_detects_release_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / 'dist').mkdir()
            (root / 'dist/app.js').write_text('old')
            before = common.manifest(root)
            (root / 'dist/app.js').write_text('changed')
            self.assertNotEqual(common.manifest(root), before)

    def test_archive_allowlist_blocks_env_db_links_and_path_traversal(self):
        for name, kind in [('service.env', tarfile.REGTYPE), ('data/db.sqlite', tarfile.REGTYPE),
                           ('../escape.js', tarfile.REGTYPE), ('dist/linked.js', tarfile.SYMTYPE)]:
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                value = tarfile.TarInfo(name); value.type = kind; value.linkname = '/etc/passwd'
                archive.addfile(value)
            stream.seek(0)
            with self.subTest(name=name), tarfile.open(fileobj=stream, mode='r:') as archive:
                with self.assertRaises(common.DeployError):
                    common.archive_members(archive, [])

    def test_same_revision_rejected_before_any_server_operation(self):
        args = types.SimpleNamespace(role='x', from_sha=OLD, to_sha=OLD)
        with patch.object(up, 'run') as run, self.assertRaisesRegex(common.DeployError, 'same_release'):
            up.prepare(args)
        run.assert_not_called()


class SidecarValidationTests(unittest.TestCase):
    def setUp(self):
        self.state = state_fixture()
        self.value = container(self.state)
        self.mod = types.SimpleNamespace(inspect=lambda _: copy.deepcopy(self.value))
        self.patcher = patch.object(up, 'legacy', return_value=self.mod)
        self.patcher.start(); self.addCleanup(self.patcher.stop)

    def test_accepts_exact_installed_sidecar(self):
        self.assertEqual(up.assert_sidecar(self.state, OLD_ID, False)['Id'], OLD_ID)

    def test_cannot_target_merchant_gateway_container(self):
        self.value['Name'] = '/merchant-gateway-app_finance-1'
        with self.assertRaisesRegex(common.DeployError, 'sidecar_name_changed'):
            up.assert_sidecar(self.state, OLD_ID, False)

    def test_rejects_identity_image_release_and_environment_changes(self):
        for mutate in (lambda v: v.update(Id=NEW_ID), lambda v: v.update(Image='latest'),
                       lambda v: v['Config']['Labels'].update({'bluev.release': NEW}),
                       lambda v: v['Config'].update(Env=['OLD_PAYMENT_SECRET=unsafe'])):
            self.value = container(self.state); mutate(self.value)
            with self.assertRaises(common.DeployError):
                up.assert_sidecar(self.state, OLD_ID, False)

    def test_rejects_old_database_mount_hostports_or_writable_root(self):
        for mutate in (lambda v: v['Mounts'].append({'Source': '/data/merchant-gateway'}),
                       lambda v: v['HostConfig'].update(PortBindings={'3114/tcp': [{'HostPort': '3114'}]}),
                       lambda v: v['HostConfig'].update(ReadonlyRootfs=False),
                       lambda v: v['Mounts'][0].update(RW=True)):
            self.value = container(self.state); mutate(self.value)
            with self.assertRaises(common.DeployError):
                up.assert_sidecar(self.state, OLD_ID, False)

    def test_rejects_extra_network_and_privileged_mode(self):
        self.value['NetworkSettings']['Networks']['host'] = {}
        with self.assertRaisesRegex(common.DeployError, 'unexpected_sidecar_network'):
            up.assert_sidecar(self.state, OLD_ID, False)
        self.value = container(self.state); self.value['HostConfig']['Privileged'] = True
        with self.assertRaisesRegex(common.DeployError, 'sidecar_isolation_changed'):
            up.assert_sidecar(self.state, OLD_ID, False)


class ConsoleUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.state = state_fixture()
        self.docker = FakeDocker(self.state)
        self.mod = types.SimpleNamespace(inspect=self.docker.inspect,
            new_container_args=lambda _: ['docker', 'create', '--name', up.NAME],
            public_checks=Mock(), old_health=Mock())
        for target, value in [('legacy', self.mod), ('read_state', self.state)]:
            p = patch.object(up, target, return_value=value); p.start(); self.addCleanup(p.stop)
        for target, kwargs in [('run', {'side_effect': self.docker.run}), ('assert_guard', {}), ('record', {}),
                               ('emit', {}), ('wait_ready', {'side_effect': lambda check, guard: (guard(), check())})]:
            p = patch.object(up, target, **kwargs); p.start(); self.addCleanup(p.stop)
        self.args = types.SimpleNamespace(role='console', to_sha=NEW)

    def test_candidate_health_before_original_stop_and_old_backup_kept(self):
        up.apply(self.args)
        self.assertEqual(self.state['status'], 'installed')
        self.assertEqual(self.docker.values[OLD_ID]['Name'], '/' + self.state['backup_name'])
        self.assertFalse(self.docker.values[OLD_ID]['State']['Running'])
        self.assertEqual(self.docker.values[OLD_ID]['NetworkSettings']['Networks'], {})
        self.assertEqual(self.docker.values[NEW_ID]['Name'], '/' + up.NAME)
        self.assertTrue(self.docker.values[NEW_ID]['State']['Running'])
        health_index = next(i for i, a in enumerate(self.docker.calls) if a[:3] == ['docker', 'exec', NEW_ID])
        stop_index = self.docker.calls.index(['docker', 'stop', '--time', '20', OLD_ID])
        self.assertLess(health_index, stop_index)

    def test_only_immutable_sidecar_ids_are_mutated(self):
        up.apply(self.args)
        for args in self.docker.calls:
            self.assertNotIn('merchant-gateway-caddy-1', args)
            self.assertNotIn('rm', args)
            if args[:2] in (['docker', 'stop'], ['docker', 'start']):
                self.assertIn(args[-1], {OLD_ID, NEW_ID})
            if args[:2] == ['docker', 'rename']:
                self.assertIn(args[2], {OLD_ID, NEW_ID})

    def test_candidate_failure_leaves_original_running_without_restart(self):
        self.docker.fail_once = lambda args: args[:3] == ['docker', 'exec', NEW_ID]
        with self.assertRaisesRegex(common.DeployError, 'injected_failure'):
            up.apply(self.args)
        self.assertEqual(self.state['status'], 'rolled_back')
        self.assertTrue(self.docker.values[OLD_ID]['State']['Running'])
        self.assertFalse(any(a[:2] in (['docker', 'stop'], ['docker', 'start']) and a[-1] == OLD_ID
                             for a in self.docker.calls))

    def test_cutover_failure_restores_original_id_without_deleting_candidate(self):
        self.docker.fail_once = lambda args: args[:2] == ['docker', 'rename'] and args[2] == NEW_ID
        with self.assertRaisesRegex(common.DeployError, 'injected_failure'):
            up.apply(self.args)
        self.assertEqual(self.state['status'], 'rolled_back')
        self.assertEqual(self.docker.values[OLD_ID]['Name'], '/' + up.NAME)
        self.assertTrue(self.docker.values[OLD_ID]['State']['Running'])
        self.assertEqual(self.docker.values[NEW_ID]['Name'], '/' + self.state['failed_name'])
        self.assertFalse(self.docker.values[NEW_ID]['State']['Running'])
        self.assertEqual(set(self.docker.values[OLD_ID]['NetworkSettings']['Networks']), {NETWORK})

    def test_explicit_rollback_after_success_restores_old_release(self):
        up.apply(self.args); up.rollback(self.args)
        self.assertEqual(self.state['status'], 'rolled_back')
        self.assertEqual(self.docker.values[OLD_ID]['Name'], '/' + up.NAME)
        self.assertTrue(self.docker.values[OLD_ID]['State']['Running'])

    def test_repeat_apply_after_installed_only_verifies(self):
        up.apply(self.args)
        count = len([a for a in self.docker.calls if a[:2] == ['docker', 'create']])
        up.apply(self.args)
        self.assertEqual(len([a for a in self.docker.calls if a[:2] == ['docker', 'create']]), count)

    def test_occupied_name_refuses_rename(self):
        self.state['candidate_id'] = NEW_ID
        self.docker.values[NEW_ID] = container(self.state, True, self.state['candidate_name'])
        with self.assertRaisesRegex(common.DeployError, 'rename_target_occupied'):
            up.sidecar_command(self.state, True, 'rename', up.NAME)

    def test_protected_baseline_change_stops_before_mutation(self):
        self.state['candidate_id'] = NEW_ID
        with patch.object(up, 'assert_guard', side_effect=common.DeployError('protected_changed')):
            with self.assertRaisesRegex(common.DeployError, 'protected_changed'):
                up.sidecar_command(self.state, False, 'stop')
        self.assertEqual(self.docker.calls, [])


class XUpgradeTests(unittest.TestCase):
    def test_atomic_link_switch_and_rollback_only_restart_isolated_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); old = root / OLD; new = root / NEW
            old.mkdir(); new.mkdir()
            try:
                (root / 'current').symlink_to(old, target_is_directory=True)
            except OSError:
                self.skipTest('symlink privilege unavailable')
            state = {'role': 'x', 'to_sha': NEW, 'old_release': str(old), 'release': str(new)}
            original_symlink = os.symlink
            original_replace = os.replace
            def replace_fixture(source, destination):
                # Production is Linux and uses atomic rename. Windows cannot
                # replace an existing directory symlink; emulate that primitive
                # only for this exact temporary fixture path.
                if os.name == 'nt':
                    self.assertEqual(destination, root / 'current')
                    self.assertTrue(destination.is_symlink())
                    destination.unlink()
                return original_replace(source, destination)
            with patch.object(up, 'legacy', return_value=types.SimpleNamespace(ROOT=root)), \
                 patch.object(up, 'assert_guard'), patch.object(up, 'run') as run, \
                 patch.object(up.os, 'replace', side_effect=replace_fixture), \
                 patch.object(up.os, 'symlink', side_effect=lambda target, path: original_symlink(target, path, target_is_directory=True)):
                up.switch_x(state, True)
                self.assertEqual((root / 'current').resolve(), new.resolve())
                up.switch_x(state, False)
                self.assertEqual((root / 'current').resolve(), old.resolve())
                self.assertEqual(run.call_count, 2)
                for call in run.call_args_list:
                    self.assertEqual(call.args[0], ['systemctl', 'restart', 'x-bluev-sandbox'])

    def test_failed_x_upgrade_calls_restore_without_database_restore(self):
        state = {'role': 'x', 'status': 'prepared', 'to_sha': NEW}
        args = types.SimpleNamespace(role='x', to_sha=NEW)
        with patch.object(up, 'read_state', return_value=state), patch.object(up, 'assert_guard'), \
             patch.object(up, 'assert_current_x'), patch.object(up, 'record'), \
             patch.object(up, 'switch_x', side_effect=common.DeployError('start_failed')), \
             patch.object(up, 'restore') as restore:
            with self.assertRaisesRegex(common.DeployError, 'start_failed'):
                up.apply(args)
            restore.assert_called_once_with(state)

    def test_stale_nonprepared_state_never_restarts(self):
        with patch.object(up, 'read_state', return_value={'status': 'applying'}), patch.object(up, 'switch_x') as switch:
            with self.assertRaisesRegex(common.DeployError, 'upgrade_not_prepared'):
                up.apply(types.SimpleNamespace(role='x'))
            switch.assert_not_called()


class PrepareAndGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'console'; self.root.mkdir()
        self.config = Path(self.temp.name) / 'config'; self.config.mkdir()
        (self.config / 'service.env').write_text('TEST_FIXTURE_ONLY=1\n')
        old_release = self.root / 'releases' / OLD
        old_release.mkdir(parents=True); (old_release / 'dist').mkdir()
        (old_release / 'package.json').write_text('{"type":"module"}')
        (old_release / 'dist/bluev-test-console-server.js').write_text('test old release')
        self.proxy = Path(self.temp.name) / 'Caddyfile'; self.proxy.write_text('unchanged test proxy')
        self.fixture = state_fixture()
        self.fixture.update(old_release=str(old_release), release=str(self.root / 'releases' / NEW))
        self.original = container(self.fixture)
        self.old_baseline = {'caddy': common.fingerprint(self.proxy), 'mounted': common.fingerprint(self.proxy),
                             'runtime': 'original-runtime', 'containers': {'untouched': 'original'}}
        self.install_path = self.root / 'deploy-state.json'
        installed = {'status': 'installed', 'release_id': OLD, 'release': str(old_release),
                     'manifest': common.manifest(old_release), 'env_sha': common.fingerprint(self.config / 'service.env'),
                     'image': IMAGE, 'network': NETWORK, 'container_id': OLD_ID,
                     'Caddyfile.candidate': common.fingerprint(self.proxy), 'candidate_runtime': 'original-runtime'}
        self.install_path.write_text(json.dumps(installed))
        self.install_bytes = self.install_path.read_bytes()
        self.artifact = Path(self.temp.name) / 'app.tar.gz'
        required = ['package.json', 'dist/bluev-test-console-server.js', 'dist/bluev-test-console.js', 'dist/bluev-test-page.js']
        with tarfile.open(self.artifact, 'w:gz') as archive:
            for name in required:
                content = b'{"type":"module"}' if name == 'package.json' else b'// test-only build'
                member = tarfile.TarInfo(name); member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
        self.mod = types.SimpleNamespace(ROOT=self.root, CONFIG=self.config, STATE=self.install_path,
            CADDYFILE=self.proxy, REQUIRED=required, inspect=lambda _: copy.deepcopy(self.original),
            old_health=Mock(), validate_network=Mock(), public_checks=Mock())
        self.args = types.SimpleNamespace(role='console', from_sha=OLD, to_sha=NEW,
            artifact=str(self.artifact), sha256=common.fingerprint(self.artifact), proxy_sha256=common.fingerprint(self.proxy))
        def fake_run(args, **kwargs):
            if args[:3] == ['docker', 'image', 'inspect']:
                return json.dumps([{'Id': IMAGE, 'Config': {}}])
            if args[:3] == ['docker', 'ps', '-a']:
                return up.NAME
            raise AssertionError('unexpected external operation')
        for name, kwargs in [('legacy', {'return_value': self.mod}), ('baseline', {'return_value': self.old_baseline}),
                             ('run', {'side_effect': fake_run}), ('console_health', {}), ('emit', {}),
                             ('scripts', {'return_value': {'upgrade-bluev-test.py': 'test-only-hash'}})]:
            p = patch.object(up, name, **kwargs); p.start(); self.addCleanup(p.stop)

    def test_prepare_preserves_install_state_env_old_release_and_proxy(self):
        before_env = (self.config / 'service.env').read_bytes()
        before_proxy = self.proxy.read_bytes()
        before_old = common.manifest(Path(self.fixture['old_release']))
        up.prepare(self.args)
        state = up.read_state(self.args)
        self.assertEqual(state['status'], 'prepared')
        self.assertEqual(state['release'], self.fixture['release'])
        self.assertEqual(self.install_path.read_bytes(), self.install_bytes)
        self.assertEqual((self.config / 'service.env').read_bytes(), before_env)
        self.assertEqual(self.proxy.read_bytes(), before_proxy)
        self.assertEqual(common.manifest(Path(self.fixture['old_release'])), before_old)
        up.assert_guard(state)
        up.prepare(self.args)
        self.assertEqual(self.install_path.read_bytes(), self.install_bytes)

    def test_bad_artifact_hash_stops_before_extract_or_state_write(self):
        self.args.sha256 = '0' * 64
        with self.assertRaisesRegex(common.DeployError, 'artifact_mismatch'):
            up.prepare(self.args)
        self.assertFalse(Path(self.fixture['release']).exists())
        self.assertFalse((self.root / 'upgrades').exists())

    def test_changed_reviewed_proxy_stops_before_extract(self):
        self.proxy.write_text('another operator changed this')
        with self.assertRaisesRegex(common.DeployError, 'reviewed_proxy_changed'):
            up.prepare(self.args)
        self.assertFalse(Path(self.fixture['release']).exists())

    def test_guard_detects_environment_first_install_state_and_old_release_changes(self):
        up.prepare(self.args)
        state = up.read_state(self.args)
        for path in (self.config / 'service.env', self.install_path,
                     Path(self.fixture['old_release']) / 'dist/bluev-test-console-server.js'):
            old = path.read_bytes(); path.write_bytes(old + b'changed')
            try:
                with self.subTest(path=path.name), self.assertRaises(common.DeployError):
                    up.assert_guard(state)
            finally:
                path.write_bytes(old)
        up.assert_guard(state)

    def test_guard_detects_legacy_identity_and_new_release_changes(self):
        up.prepare(self.args)
        state = up.read_state(self.args)
        with patch.object(up, 'baseline', return_value={'changed': True}):
            with self.assertRaisesRegex(common.DeployError, 'protected_service_or_configuration_changed'):
                up.assert_guard(state)
        (Path(state['release']) / 'dist/bluev-test-page.js').write_text('unexpected change')
        with self.assertRaisesRegex(common.DeployError, 'new_release_changed'):
            up.assert_guard(state)

    def installed_parent(self):
        up.prepare(self.args)
        parent = up.read_state(self.args)
        parent['status'] = 'installed'; parent['candidate_id'] = NEW_ID
        parent['scripts'] = {'upgrade-bluev-test.py': 'historical-script-hash-must-not-match-current'}
        parent.pop('parent', None)  # The real 3d9 release used v1 parentless records.
        up.record(parent)
        self.original = container(parent, True)
        self.original['State']['Running'] = True
        self.args.from_sha = NEW; self.args.to_sha = 'f' * 40
        return parent

    def test_continuous_prepare_uses_active_parent_id_and_keeps_initial_state(self):
        parent = self.installed_parent()
        parent_path = up.state_path('console', NEW)
        parent_bytes = parent_path.read_bytes()
        up.prepare(self.args)
        child = up.read_state(self.args)
        self.assertEqual(child['parent'], {'kind': 'upgrade', 'release_id': NEW,
                                          'sha256': common.sha(parent_bytes)})
        self.assertEqual(child['old_release'], parent['release'])
        self.assertEqual(child['old_container_id'], NEW_ID)
        self.assertNotEqual(child['old_container_id'], OLD_ID)
        self.assertEqual(self.install_path.read_bytes(), self.install_bytes)
        self.assertEqual(parent_path.read_bytes(), parent_bytes)
        up.assert_guard(child)

    def test_changed_parent_record_invalidates_child_even_if_only_whitespace(self):
        self.installed_parent(); up.prepare(self.args)
        child = up.read_state(self.args)
        path = up.state_path('console', NEW)
        path.write_bytes(path.read_bytes() + b'\n')
        with self.assertRaisesRegex(common.DeployError, 'upgrade_parent_changed'):
            up.assert_guard(child)

    def test_current_script_change_is_rejected_but_historical_script_change_is_not_compared(self):
        self.installed_parent(); up.prepare(self.args)
        child = up.read_state(self.args)
        up.assert_guard(child)
        with patch.object(up, 'scripts', return_value={'newer-unreviewed-script': 'changed'}):
            with self.assertRaisesRegex(common.DeployError, 'upgrade_script_changed'):
                up.assert_guard(child)

    def test_parent_must_be_installed_and_its_active_container_must_match(self):
        parent = self.installed_parent()
        parent['status'] = 'rolled_back'; up.record(parent)
        with self.assertRaisesRegex(common.DeployError, 'previous_upgrade_not_installed'):
            up.prepare(self.args)
        parent['status'] = 'installed'; up.record(parent)
        self.original['Id'] = OLD_ID
        with self.assertRaisesRegex(common.DeployError, 'sidecar_identity_changed'):
            up.prepare(self.args)

    def test_parent_chain_cannot_change_protected_baseline(self):
        parent = self.installed_parent()
        parent['baseline'] = {'forged': True}; up.record(parent)
        with self.assertRaisesRegex(common.DeployError, 'protected_service_or_configuration_changed'):
            up.prepare(self.args)

    def test_changed_historical_release_is_rejected(self):
        self.installed_parent()
        (self.root / 'releases' / OLD / 'dist/bluev-test-console-server.js').write_text('tampered old code')
        with self.assertRaisesRegex(common.DeployError, 'old_release_changed'):
            up.prepare(self.args)

    def test_child_container_id_is_anchored_to_parent_candidate_not_first_install(self):
        self.installed_parent(); up.prepare(self.args)
        child = up.read_state(self.args)
        child['old_container_id'] = OLD_ID
        with self.assertRaisesRegex(common.DeployError, 'upgrade_parent_container_mismatch'):
            up.assert_guard(child)


class RollbackDataTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'; self.data.mkdir()
        self.path = self.data / 'bluev-sandbox.sqlite'
        self.old = self.root / 'releases' / OLD; self.old.mkdir(parents=True)
        self.new = self.root / 'releases' / NEW; self.new.mkdir(parents=True)
        self.unit = self.root / 'sandbox.service'; self.unit.write_text('test unit')
        self.mod = types.SimpleNamespace(ROOT=self.root, DATA=self.data, UNIT=self.unit)
        self.state = {'role': 'x', 'old_release': str(self.old), 'release': str(self.new),
                      'old_manifest': {}, 'to_sha': NEW, 'from_sha': OLD}
        self.sql('CREATE TABLE test_fixture(id INTEGER)')
        p = patch.object(up, 'legacy', return_value=self.mod); p.start(); self.addCleanup(p.stop)

    def sql(self, script):
        connection = sqlite3.connect(self.path)
        try:
            connection.executescript(script); connection.commit()
        finally:
            connection.close()

    def seed(self):
        self.sql('''CREATE TABLE bluev_alipay_versions(revision INTEGER PRIMARY KEY,identity_id TEXT,secret_ciphertext TEXT);
          CREATE TABLE bluev_alipay_settings(id INTEGER PRIMARY KEY,active_revision INTEGER);
          CREATE TABLE bluev_alipay_order_identities(order_id TEXT PRIMARY KEY,identity_id TEXT,bound_revision INTEGER);
          INSERT INTO bluev_alipay_versions VALUES(1,'initial-test-identity','DO_NOT_SELECT_THIS_TEST_SENTINEL');
          INSERT INTO bluev_alipay_settings VALUES(1,1);
          INSERT INTO bluev_alipay_order_identities VALUES('original-test-order','initial-test-identity',1);''')

    def save_second_profile(self):
        self.sql("INSERT INTO bluev_alipay_versions VALUES(2,'changed-test-identity','TEST_ONLY');"
                 "UPDATE bluev_alipay_settings SET active_revision=2 WHERE id=1;")

    def closures(self, count=0):
        self.sql('CREATE TABLE bluev_test_closures(request_id TEXT PRIMARY KEY)')
        if count:
            self.sql("INSERT INTO bluev_test_closures VALUES('test-request')")

    def capability(self, module, contents):
        target = self.old / module; target.parent.mkdir(exist_ok=True, parents=True)
        target.write_text(contents)
        self.state['old_manifest'][module] = common.fingerprint(target)

    def current_link(self):
        try:
            (self.root / 'current').symlink_to(self.new, target_is_directory=True)
        except OSError:
            self.skipTest('symlink privilege unavailable')

    def test_absent_new_tables_allow_legacy_rollback(self):
        self.assertEqual(up.payment_profile_revision(), 0)
        self.assertEqual(up.closed_test_count(), 0)
        up.assert_data_rollback(self.state)

    def test_seed_revision_one_allows_rollback_without_reading_secrets_or_writing_database(self):
        self.seed(); before = self.path.read_bytes(); statements = []
        connect = sqlite3.connect
        def traced(*args, **kwargs):
            connection = connect(*args, **kwargs)
            connection.set_trace_callback(statements.append)
            return connection
        with patch.object(up.sqlite3, 'connect', side_effect=traced):
            up.assert_data_rollback(self.state)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertNotIn('secret_ciphertext', '\n'.join(statements))
        self.assertNotIn('DO_NOT_SELECT_THIS_TEST_SENTINEL', '\n'.join(statements))
        self.assertFalse(any(command.startswith(('UPDATE ', 'DELETE ', 'INSERT ')) for command in statements))

    def test_any_saved_revision_blocks_legacy_even_if_active_returns_to_one(self):
        self.seed(); self.save_second_profile()
        self.sql('UPDATE bluev_alipay_settings SET active_revision=1')
        self.assertEqual(up.payment_profile_revision(), 2)
        with self.assertRaisesRegex(common.DeployError, 'payment_profile_rollback_blocked'):
            up.assert_data_rollback(self.state)

    def test_current_profile_support_capability_allows_compatible_rollback(self):
        self.seed(); self.save_second_profile()
        self.capability(up.PROFILE_MODULE, 'export const BLUEV_PAYMENT_PROFILE_SCHEMA_VERSION = 1;')
        up.assert_data_rollback(self.state)
        (self.old / up.PROFILE_MODULE).write_text('export const BLUEV_PAYMENT_PROFILE_SCHEMA_VERSION = 2;')
        with self.assertRaisesRegex(common.DeployError, 'old_profile_module_changed'):
            up.assert_data_rollback(self.state)

    def test_incomplete_profile_tables_are_not_treated_as_unconfigured(self):
        self.sql('CREATE TABLE bluev_alipay_versions(revision INTEGER PRIMARY KEY)')
        with self.assertRaisesRegex(common.DeployError, 'payment_profile_schema_invalid'):
            up.payment_profile_revision()

    def test_invalid_active_reference_blocks_rollback(self):
        self.seed(); self.sql('UPDATE bluev_alipay_settings SET active_revision=99')
        with self.assertRaisesRegex(common.DeployError, 'payment_profile_active_invalid'):
            up.payment_profile_revision()

    def test_missing_historical_revision_blocks_rollback(self):
        self.seed(); self.sql("INSERT INTO bluev_alipay_versions VALUES(3,'third','TEST_ONLY')")
        with self.assertRaisesRegex(common.DeployError, 'payment_profile_revision_invalid'):
            up.payment_profile_revision()

    def test_mismatched_order_identity_blocks_rollback(self):
        self.seed(); self.sql("UPDATE bluev_alipay_order_identities SET identity_id='mismatch'")
        with self.assertRaisesRegex(common.DeployError, 'payment_profile_binding_invalid'):
            up.payment_profile_revision()

    def test_profile_sql_errors_are_safe_and_fail_closed(self):
        self.path.write_bytes(b'not a sqlite database')
        with self.assertRaisesRegex(common.DeployError, '^payment_profile_state_unreadable$'):
            up.payment_profile_revision()

    def test_closures_block_rollback_to_code_without_closure_support(self):
        self.seed(); self.closures(1)
        self.assertEqual(up.closed_test_count(), 1)
        with self.assertRaisesRegex(common.DeployError, 'test_closure_rollback_blocked'):
            up.assert_data_rollback(self.state)
        self.capability('dist/bluev-sandbox.js', 'const tableName = "bluev_test_closures";')
        up.assert_data_rollback(self.state)

    def test_closure_schema_errors_fail_closed(self):
        self.sql('CREATE TABLE bluev_test_closures(unrelated TEXT)')
        with self.assertRaisesRegex(common.DeployError, '^test_closure_state_unreadable$'):
            up.closed_test_count()

    def test_preexisting_saved_configuration_blocks_before_service_stop(self):
        self.seed(); self.save_second_profile()
        with patch.object(up, 'run') as run, patch.object(up, 'switch_x') as switch:
            with self.assertRaisesRegex(common.DeployError, 'payment_profile_rollback_blocked'):
                up.restore_x(self.state)
            run.assert_not_called(); switch.assert_not_called()

    def test_profile_saved_while_stopping_resumes_same_new_release_never_downgrades(self):
        self.seed(); self.current_link()
        def run(args, **kwargs):
            if args[:2] == ['systemctl', 'stop']:
                self.save_second_profile()
            return ''
        with patch.object(up, 'assert_guard'), patch.object(up, 'run', side_effect=run) as command, \
             patch.object(up, 'service_identity', return_value={'MainPID': '0', 'FragmentPath': str(self.unit)}), \
             patch.object(up, 'switch_x') as switch:
            with self.assertRaisesRegex(common.DeployError, 'payment_profile_rollback_blocked'):
                up.restore_x(self.state)
            switch.assert_not_called()
            self.assertEqual([call.args[0] for call in command.call_args_list],
                             [['systemctl', 'stop', up.SERVICE], ['systemctl', 'start', up.SERVICE]])
        self.assertEqual((self.root / 'current').resolve(), self.new.resolve())

    def test_test_closed_while_stopping_resumes_same_new_release_never_downgrades(self):
        self.seed(); self.closures(); self.current_link()
        def run(args, **kwargs):
            if args[:2] == ['systemctl', 'stop']:
                self.sql("INSERT INTO bluev_test_closures VALUES('closed-during-drain')")
            return ''
        with patch.object(up, 'assert_guard'), patch.object(up, 'run', side_effect=run) as command, \
             patch.object(up, 'service_identity', return_value={'MainPID': '0', 'FragmentPath': str(self.unit)}), \
             patch.object(up, 'switch_x') as switch:
            with self.assertRaisesRegex(common.DeployError, 'test_closure_rollback_blocked'):
                up.restore_x(self.state)
            switch.assert_not_called()
            self.assertEqual(command.call_args_list[-1].args[0], ['systemctl', 'start', up.SERVICE])
        self.assertEqual((self.root / 'current').resolve(), self.new.resolve())

    def test_seed_only_drain_allows_safe_old_release_switch(self):
        self.seed(); self.closures(); self.current_link()
        with patch.object(up, 'assert_guard'), patch.object(up, 'run') as command, \
             patch.object(up, 'service_identity', return_value={'MainPID': '0', 'FragmentPath': str(self.unit)}), \
             patch.object(up, 'switch_x') as switch:
            up.restore_x(self.state)
            switch.assert_called_once_with(self.state, False)
            command.assert_called_once_with(['systemctl', 'stop', up.SERVICE], timeout=50)

    def test_unconfirmed_stop_never_switches_release(self):
        self.seed(); self.current_link()
        with patch.object(up, 'assert_guard'), patch.object(up, 'run'), \
             patch.object(up, 'service_identity', return_value={'MainPID': '123', 'FragmentPath': str(self.unit)}), \
             patch.object(up, 'switch_x') as switch:
            with self.assertRaisesRegex(common.DeployError, 'sandbox_stop_unconfirmed'):
                up.restore_x(self.state)
            switch.assert_not_called()

    def test_automatic_rollback_reports_block_and_keeps_database(self):
        self.seed(); self.save_second_profile()
        state = {**self.state, 'status': 'prepared'}
        args = types.SimpleNamespace(role='x', to_sha=NEW)
        before = self.path.read_bytes()
        with patch.object(up, 'read_state', return_value=state), patch.object(up, 'assert_guard'), \
             patch.object(up, 'assert_current_x'), patch.object(up, 'record'), patch.object(up, 'emit') as emit, \
             patch.object(up, 'switch_x', side_effect=common.DeployError('new_service_failed')):
            with self.assertRaisesRegex(common.DeployError, 'new_service_failed'):
                up.apply(args)
        self.assertEqual(state['status'], 'rollback_required')
        self.assertEqual(emit.call_args.kwargs['code'], 'payment_profile_rollback_blocked')
        self.assertEqual(self.path.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
