"""Upgrade ONLY the two installed BlueV test sidecars. Never restore a database.

Keep this file, bluev_deploy_common.py and both original deploy-bluev-*.py files
together. The first-install deploy-state is immutable. Each upgrade has its own
state and keeps the old release/container for an explicit or automatic rollback.
"""
from __future__ import annotations
import argparse
import importlib.util
import os
from pathlib import Path
import re
import tarfile
from bluev_deploy_common import *

HERE = Path(__file__).resolve().parent
NAME = 'bluev-test-console'
SERVICE = 'x-bluev-sandbox'
MODULES = {}


def legacy(role):
    require(role in {'x', 'console'}, 'invalid_role')
    if role not in MODULES:
        filename = 'deploy-bluev-sandbox.py' if role == 'x' else 'deploy-bluev-test-console.py'
        spec = importlib.util.spec_from_file_location('bluev_upgrade_' + role, HERE / filename)
        value = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(value)
        MODULES[role] = value
    return MODULES[role]


def revision(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{40}', value), 'commit_sha_required')
    return value


def regular_tree(path):
    require(path.is_absolute(), 'absolute_path_required')
    for parent in (path, *path.parents):
        require(not parent.is_symlink(), 'target_symlink_forbidden')
    require(path.is_dir(), 'target_directory_required')


def state_path(role, to_sha):
    return legacy(role).ROOT / 'upgrades' / (revision(to_sha) + '.json')


def scripts():
    return {name: fingerprint(HERE / name) for name in (
        'upgrade-bluev-test.py', 'bluev_deploy_common.py',
        'deploy-bluev-sandbox.py', 'deploy-bluev-test-console.py')}


def db_identity(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_nlink == 1,
            'sandbox_database_invalid')
    return [path.stat().st_dev, path.stat().st_ino]


def baseline(role):
    mod = legacy(role)
    if role == 'x':
        return {'legacy': mod.old_baseline(), 'files': {str(path): fingerprint(path)
                for path in (mod.SITE, mod.SNIPPET, mod.UNIT)},
                'database_identity': db_identity(mod.DATA / 'bluev-sandbox.sqlite'),
                'gate': fingerprint(mod.DATA / 'sales.enabled', optional=True)}
    mod.assert_mount()
    return {'containers': mod.old_containers(), 'compose': fingerprint(mod.COMPOSE),
            'caddy': fingerprint(mod.CADDYFILE), 'inode': mod.CADDYFILE.stat().st_ino,
            'mounted': sha(mod.mounted_config().encode()), 'runtime': mod.active_config()}


def assert_guard(state):
    mod = legacy(state['role'])
    for path in (mod.ROOT, mod.CONFIG, mod.ROOT / 'upgrades', Path(state['old_release']), Path(state['release'])):
        regular_tree(path)
    if state['role'] == 'x':
        regular_tree(mod.DATA)
    require(scripts() == state['scripts'], 'upgrade_script_changed')
    require(fingerprint(mod.STATE) == state['install_state_sha'], 'first_install_state_changed')
    require(fingerprint(mod.CONFIG / 'service.env') == state['env_sha'], 'environment_changed')
    require(manifest(Path(state['old_release'])) == state['old_manifest'], 'old_release_changed')
    require(baseline(state['role']) == state['baseline'], 'protected_service_or_configuration_changed')
    if 'manifest' in state:
        require(manifest(Path(state['release'])) == state['manifest'], 'new_release_changed')


def record(state):
    save(state_path(state['role'], state['to_sha']), state)


def read_state(args):
    mod = legacy(args.role)
    regular_tree(mod.ROOT)
    regular_tree(mod.ROOT / 'upgrades')
    state = load(state_path(args.role, args.to_sha))
    require(state.get('role') == args.role and state.get('to_sha') == args.to_sha, 'upgrade_state_mismatch')
    revision(state.get('from_sha'))
    require(state['from_sha'] != state['to_sha'], 'same_release')
    require(state.get('release') == str(mod.ROOT / 'releases' / state['to_sha']) and
            state.get('old_release') == str(mod.ROOT / 'releases' / state['from_sha']), 'release_target_invalid')
    regular_tree(Path(state['old_release']))
    regular_tree(Path(state['release']))
    return state


def assert_current_x(state, new):
    mod = legacy('x')
    expected = Path(state['release'] if new else state['old_release'])
    current = mod.ROOT / 'current'
    require(current.is_symlink() and current.resolve(strict=True) == expected, 'current_release_changed')
    identity = service_identity(SERVICE)
    require(identity.get('FragmentPath') == str(mod.UNIT), 'unexpected_sandbox_unit')
    require(Path('/proc').joinpath(identity['MainPID'], 'cwd').resolve(strict=True) == expected,
            'sandbox_process_release_mismatch')


def assert_sidecar(state, container_id, new):
    mod = legacy('console')
    require(re.fullmatch(r'[a-f0-9]{64}', container_id or ''), 'container_id_invalid')
    value = mod.inspect(container_id)
    expected_release = state['release'] if new else state['old_release']
    expected_sha = state['to_sha'] if new else state['from_sha']
    require(value['Id'] == container_id and value['Image'] == state['image'], 'sidecar_identity_changed')
    config, host = value['Config'], value['HostConfig']
    require(config.get('Labels', {}).get('bluev.release') == expected_sha and
            config.get('User') == '1000:1000' and config.get('WorkingDir') == '/app' and
            config.get('Entrypoint') == ['node'] and config.get('Cmd') == ['dist/bluev-test-console-server.js'],
            'sidecar_configuration_changed')
    require(canonical(sorted(config.get('Env') or [])) == state['container_env_sha'], 'sidecar_environment_changed')
    require(host.get('ReadonlyRootfs') is True and not host.get('Privileged') and not host.get('PortBindings')
            and host.get('NetworkMode') == state['network'] and host.get('CapDrop') == ['ALL'],
            'sidecar_isolation_changed')
    mounts = value['Mounts']
    require(len(mounts) == 1 and mounts[0].get('Type') == 'bind' and mounts[0]['Source'] == expected_release
            and mounts[0]['Destination'] == '/app' and mounts[0]['RW'] is False, 'sidecar_mount_changed')
    allowed = {NAME, state['candidate_name'] if new else state['backup_name'], state['failed_name'] if new else NAME}
    require(value['Name'].removeprefix('/') in allowed, 'sidecar_name_changed')
    require(set(value['NetworkSettings']['Networks']).issubset({state['network']}), 'unexpected_sidecar_network')
    return value


def console_health(name):
    # Local /health has no upstream/payment side effects and does not read credentials.
    code = "const r=await fetch('http://127.0.0.1:3114/health');console.log(JSON.stringify({status:r.status,body:await r.json()}));"
    value = json.loads(run(['docker', 'exec', name, 'node', '--input-type=module', '-e', code]))
    require(value == {'status': 200, 'body': {'ok': True, 'service': NAME}}, 'sidecar_health_failed')


def verify_state(state, new=True):
    assert_guard(state)
    mod = legacy(state['role'])
    if state['role'] == 'x':
        assert_current_x(state, new)
        mod.local_checks()
    else:
        value = assert_sidecar(state, state['candidate_id'] if new else state['old_container_id'], new)
        require(value['Name'] == '/' + NAME and value['State']['Running'], 'active_sidecar_invalid')
        require(set(value['NetworkSettings']['Networks']) == {state['network']}, 'sidecar_network_missing')
        console_health(value['Id'])
        mod.public_checks()
    mod.old_health()
    assert_guard(state)


def prepare(args):
    mod = legacy(args.role)
    revision(args.from_sha); revision(args.to_sha)
    require(args.from_sha != args.to_sha, 'same_release')
    require(re.fullmatch(r'[a-f0-9]{64}', args.sha256) and
            re.fullmatch(r'[a-f0-9]{64}', args.proxy_sha256), 'sha256_required')
    artifact = Path(args.artifact)
    require(artifact.is_absolute() and fingerprint(artifact) == args.sha256, 'artifact_mismatch')
    regular_tree(mod.ROOT); regular_tree(mod.ROOT / 'releases'); regular_tree(mod.CONFIG)
    installed = load(mod.STATE)
    require(installed.get('status') == 'installed' and installed.get('release_id') == args.from_sha and
            installed.get('release') == str(mod.ROOT / 'releases' / args.from_sha), 'installed_base_required')
    path = state_path(args.role, args.to_sha)
    if path.exists() or path.is_symlink():
        state = read_state(args)
        require(state.get('status') in {'prepared', 'installed', 'rolled_back'} and
                state['from_sha'] == args.from_sha and state['artifact_sha'] == args.sha256 and
                state['proxy_sha'] == args.proxy_sha256, 'existing_upgrade_conflict')
        assert_guard(state)
        emit('already_prepared', role=args.role, status=state['status'])
        return
    old_release = Path(installed['release']); regular_tree(old_release)
    require(manifest(old_release) == installed['manifest'], 'installed_release_changed')
    require(fingerprint(mod.CONFIG / 'service.env') == installed['env_sha'], 'installed_environment_changed')
    proxy = mod.SITE if args.role == 'x' else mod.CADDYFILE
    require(fingerprint(proxy) == args.proxy_sha256, 'reviewed_proxy_changed')
    release = mod.ROOT / 'releases' / args.to_sha
    require(not release.exists() and not release.is_symlink(), 'new_release_already_exists')
    with tarfile.open(artifact, 'r:*') as archive:
        archive_members(archive, mod.REQUIRED)
    state = {'role': args.role, 'from_sha': args.from_sha, 'to_sha': args.to_sha, 'status': 'preparing',
             'release': str(release), 'old_release': str(old_release), 'artifact_sha': args.sha256,
             'proxy_sha': args.proxy_sha256, 'scripts': scripts(), 'install_state_sha': fingerprint(mod.STATE),
             'env_sha': installed['env_sha'], 'old_manifest': installed['manifest'], 'baseline': baseline(args.role)}
    if args.role == 'x':
        regular_tree(mod.DATA)
        require(fingerprint(mod.UNIT) == installed['bundle']['x-bluev-sandbox.service'] and
                fingerprint(mod.SNIPPET) == installed['bundle']['bluev-sandbox-nginx.conf'] and
                fingerprint(mod.SITE) == installed['nginx.candidate'], 'installed_x_route_or_unit_changed')
        assert_current_x(state, False)
        require(run([mod.NODE, '--version']).startswith('v24.'), 'node24_required')
    else:
        require(state['baseline']['caddy'] == installed['Caddyfile.candidate'] and
                state['baseline']['runtime'] == installed['candidate_runtime'] and
                state['baseline']['mounted'] == installed['Caddyfile.candidate'], 'installed_console_route_changed')
        state.update(image=installed['image'], network=installed['network'], old_container_id=installed['container_id'],
                     candidate_name=NAME + '-candidate-' + args.to_sha[:12],
                     backup_name=NAME + '-backup-' + args.to_sha[:12], failed_name=NAME + '-failed-' + args.to_sha[:12])
        require(re.fullmatch(r'sha256:[a-f0-9]{64}', state['image']), 'immutable_image_required')
        original = mod.inspect(NAME)
        state['container_env_sha'] = canonical(sorted(original['Config'].get('Env') or []))
        value = assert_sidecar(state, state['old_container_id'], False)
        require(value['Name'] == '/' + NAME and value['State']['Running'], 'installed_sidecar_unavailable')
        require(set(value['NetworkSettings']['Networks']) == {state['network']}, 'installed_sidecar_network_invalid')
        image = json.loads(run(['docker', 'image', 'inspect', state['image']]))[0]
        require(image['Id'] == state['image'] and not image.get('Config', {}).get('Volumes'), 'image_invalid')
        mod.validate_network(state['network'])
        occupied = run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
        require(not any(state[key] in occupied for key in ('candidate_name', 'backup_name', 'failed_name')), 'upgrade_container_name_in_use')
        console_health(state['old_container_id'])
    mod.old_health()
    upgrades = mod.ROOT / 'upgrades'
    if not upgrades.exists():
        upgrades.mkdir(mode=0o700)
    regular_tree(upgrades)
    record(state)
    extract(artifact, release, mod.REQUIRED)
    require(load(release / 'package.json').get('type') == 'module', 'esm_required')
    if args.role == 'x':
        run([mod.NODE, '--check', str(release / 'dist/bluev-sandbox-server.js')])
        run(['/opt/node/bin/npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund',
             '--prefix', str(release)], timeout=300)
    state['manifest'] = manifest(release)
    assert_guard(state)
    state['status'] = 'prepared'; record(state)
    emit('prepared', role=args.role, to_sha=args.to_sha, old_services_unchanged=True)


def switch_x(state, new):
    mod = legacy('x')
    current = mod.ROOT / 'current'
    allowed = {Path(state['release']), Path(state['old_release'])}
    require(current.is_symlink() and current.resolve(strict=True) in allowed, 'current_release_changed')
    target = Path(state['release'] if new else state['old_release'])
    temporary = mod.ROOT / ('.upgrade-current-' + state['to_sha'])
    require(not temporary.exists() and not temporary.is_symlink(), 'switch_temporary_exists')
    assert_guard(state)
    os.symlink(target, temporary)
    os.replace(temporary, current)
    # Only this exact isolated service can ever be restarted.
    run(['systemctl', 'restart', SERVICE], timeout=50)


def sidecar_command(state, new, operation, name=None):
    container_id = state['candidate_id'] if new else state['old_container_id']
    assert_guard(state)
    value = assert_sidecar(state, container_id, new)
    if operation == 'stop':
        if value['State']['Running']:
            run(['docker', 'stop', '--time', '20', container_id])
    elif operation == 'start':
        if not value['State']['Running']:
            run(['docker', 'start', container_id])
    elif operation == 'disconnect':
        if state['network'] in value['NetworkSettings']['Networks']:
            run(['docker', 'network', 'disconnect', state['network'], container_id])
    elif operation == 'connect':
        if state['network'] not in value['NetworkSettings']['Networks']:
            run(['docker', 'network', 'connect', '--alias', NAME, state['network'], container_id])
    elif operation == 'rename':
        require(name in {NAME, state['backup_name'], state['failed_name']}, 'rename_target_invalid')
        if value['Name'] != '/' + name:
            require(name not in run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines(), 'rename_target_occupied')
            run(['docker', 'rename', container_id, name])
    else:
        raise DeployError('sidecar_operation_invalid')


def apply_console(state):
    mod = legacy('console')
    value = assert_sidecar(state, state['old_container_id'], False)
    require(value['Name'] == '/' + NAME and value['State']['Running'], 'original_sidecar_not_active')
    args = mod.new_container_args({**state, 'release_id': state['to_sha']})
    require(args[:4] == ['docker', 'create', '--name', NAME], 'unexpected_container_command')
    args[3] = state['candidate_name']
    assert_guard(state)
    state['candidate_id'] = run(args).strip()
    require(re.fullmatch(r'[a-f0-9]{64}', state['candidate_id']), 'candidate_creation_invalid')
    record(state)
    sidecar_command(state, True, 'start')
    wait_ready(lambda: console_health(state['candidate_id']), lambda: assert_guard(state))
    # Detach both private sidecars before assigning the stable DNS alias. The old
    # business containers and Caddy are never stopped, reloaded, renamed or copied.
    sidecar_command(state, True, 'stop')
    sidecar_command(state, True, 'disconnect')
    state['cutover_started'] = True; record(state)
    sidecar_command(state, False, 'stop')
    sidecar_command(state, False, 'disconnect')
    sidecar_command(state, False, 'rename', state['backup_name'])
    sidecar_command(state, True, 'rename', NAME)
    sidecar_command(state, True, 'connect')
    sidecar_command(state, True, 'start')


def restore(state):
    assert_guard(state)
    if state['role'] == 'x':
        switch_x(state, False)
    else:
        if state.get('candidate_id'):
            sidecar_command(state, True, 'stop')
            sidecar_command(state, True, 'disconnect')
            sidecar_command(state, True, 'rename', state['failed_name'])
        sidecar_command(state, False, 'rename', NAME)
        sidecar_command(state, False, 'connect')
        sidecar_command(state, False, 'start')
    wait_ready(lambda: verify_state(state, False), lambda: assert_guard(state))
    state['status'] = 'rolled_back'; record(state)
    emit('rolled_back', role=state['role'], database_preserved=True, old_services_unchanged=True)


def apply(args):
    state = read_state(args)
    if state['status'] == 'installed':
        verify_state(state); emit('already_installed', role=args.role); return
    require(state['status'] == 'prepared', 'upgrade_not_prepared')
    assert_guard(state)
    if args.role == 'x':
        assert_current_x(state, False)
    state['status'] = 'applying'; record(state)
    try:
        if args.role == 'x':
            switch_x(state, True)
        else:
            apply_console(state)
        wait_ready(lambda: verify_state(state), lambda: assert_guard(state))
        state['status'] = 'installed'; record(state)
        emit('installed', role=args.role, to_sha=args.to_sha, database_preserved=True, old_services_unchanged=True)
    except BaseException:
        try:
            restore(state)
        except BaseException:
            state['status'] = 'rollback_required'; record(state)
            emit('rollback_required', role=args.role, database_preserved=True, old_services_restarted=False)
        raise


def verify(args):
    state = read_state(args)
    require(state['status'] in {'installed', 'rolled_back'}, 'upgrade_not_terminal')
    verify_state(state, state['status'] == 'installed')
    emit('verified', role=args.role, status=state['status'], old_services_unchanged=True, no_payment_created=True)


def rollback(args):
    state = read_state(args)
    require(state['status'] in {'applying', 'installed', 'rollback_required', 'rolled_back'}, 'rollback_state_invalid')
    if state['status'] == 'rolled_back':
        verify_state(state, False); emit('already_rolled_back', role=args.role); return
    restore(state)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--role', choices=['x', 'console'], required=True)
    commands = parser.add_subparsers(dest='action', required=True)
    preparation = commands.add_parser('prepare')
    for option in ('from-sha', 'to-sha', 'artifact', 'sha256', 'proxy-sha256'):
        preparation.add_argument('--' + option, required=True)
    for name in ('apply', 'verify', 'rollback'):
        commands.add_parser(name).add_argument('--to-sha', required=True)
    # Also acquire the original deployment lock: first-install and upgrade must
    # never race even though their state files are intentionally separate.
    role_args, _ = parser.parse_known_args()
    lock = '/run/lock/x-bluev-sandbox-deploy.lock' if role_args.role == 'x' else '/run/lock/bluev-test-console-deploy.lock'
    locked_main(parser, {'prepare': prepare, 'apply': apply, 'verify': verify, 'rollback': rollback}, lock)


if __name__ == '__main__':
    main()
