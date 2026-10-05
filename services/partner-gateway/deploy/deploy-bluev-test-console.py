"""Quefa host only. New sidecar; Caddy reload preserves bind inode/old containers."""
from __future__ import annotations
import argparse
from pathlib import Path
import re
import tarfile
from bluev_deploy_common import *

HERE = Path(__file__).resolve().parent
ROOT = Path('/opt/bluev-test-console')
CONFIG = Path('/etc/bluev-test-console')
STATE = ROOT / 'deploy-state.json'
CADDYFILE = Path('/opt/merchant-gateway/Caddyfile')
COMPOSE = Path('/opt/merchant-gateway/compose.yaml')
CADDY = 'merchant-gateway-caddy-1'
CONTAINER_CONFIG = '/etc/caddy/Caddyfile'
NAME = 'bluev-test-console'
PUBLIC = 'https://api.quefa.cn'
FILES = ['deploy-bluev-test-console.py', 'bluev_deploy_common.py', 'bluev-test-console-caddy.conf']
REQUIRED = ['package.json', 'dist/bluev-test-console-server.js', 'dist/bluev-test-console.js', 'dist/bluev-test-page.js']

def bundle():
    return {name: fingerprint(HERE / name) for name in FILES}

def inspect(name):
    return json.loads(run(['docker', 'inspect', name]))[0]

def identity(name):
    value = inspect(name)
    require(value['State']['Running'] is True, 'old_container_not_running')
    return {'id': value['Id'], 'image': value['Image'], 'started_at': value['State']['StartedAt']}

def old_containers():
    names = sorted(run(['docker', 'ps', '--format', '{{.Names}}']).splitlines())
    names = [name for name in names if name.startswith('merchant-gateway-')]
    require(CADDY in names and len(names) >= 3, 'old_containers_missing')
    return {name: identity(name) for name in names}

def assert_mount():
    mounts = [item for item in inspect(CADDY)['Mounts'] if item['Destination'] == CONTAINER_CONFIG]
    require(len(mounts) == 1 and mounts[0]['Type'] == 'bind' and mounts[0]['Source'] == str(CADDYFILE),
            'unexpected_caddy_mount')
    fingerprint(CADDYFILE)

def mounted_config():
    return run(['docker', 'exec', CADDY, 'cat', CONTAINER_CONFIG])

def adapt(text):
    return canonical(json.loads(run(['docker', 'exec', '-i', CADDY, 'caddy', 'adapt', '--config', '-',
                                    '--adapter', 'caddyfile', '--validate'], input_text=text)))

def active_config():
    return canonical(json.loads(run(['docker', 'exec', CADDY, 'wget', '-qO-', 'http://127.0.0.1:2019/config/'])))

def reload(text):
    run(['docker', 'exec', '-i', CADDY, 'caddy', 'reload', '--config', '-', '--adapter', 'caddyfile'], input_text=text)

def caddy_block_parents(text):
    """Find structural parents without confusing quoted/commented braces for blocks.

    Placeholder braces such as {uri} are balanced token-local pairs and therefore
    cannot change the parent of a subsequent route block. This is a locator only;
    the installed Caddy binary still performs the full adapt/validate check.
    """
    parents, stack = {}, []
    quote = None
    index = 0
    while index < len(text):
        char = text[index]
        if quote is not None:
            if char == quote:
                quote = None
            elif char == '\\' and quote == '"':
                index += 1
        elif char in ('"', '`'):
            quote = char
        elif char == '#':
            newline = text.find('\n', index)
            if newline < 0:
                break
            index = newline
        elif char == '\\':
            index += 1
        elif char == '{':
            parents[index] = stack[-1] if stack else None
            stack.append(index)
        elif char == '}':
            require(stack, 'caddy_unbalanced_blocks')
            stack.pop()
        index += 1
    require(not stack and quote is None, 'caddy_unbalanced_blocks')
    return parents

def candidate_config(original):
    require('bluev_test_shell' not in original and '/admin/bluev-test' not in original
            and NAME not in original, 'sandbox_route_already_exists')
    parents = caddy_block_parents(original)
    sites = [match for match in re.finditer(r'^api\.quefa\.cn[ \t]*(?P<open>\{)[ \t]*(?:#[^\r\n]*)?\r?\n', original, re.MULTILINE)
             if match.start('open') in parents and parents[match.start('open')] is None]
    require(len(sites) == 1, 'api_site_ambiguous')
    site_open = sites[0].start('open')
    routes = [match for match in re.finditer(r'^(?P<indent>[ \t]+)route[ \t]*(?P<open>\{)[ \t]*(?:#[^\r\n]*)?\r?\n', original, re.MULTILINE)
              if parents.get(match.start('open')) == site_open]
    require(len(routes) == 1, 'api_route_ambiguous')
    match = routes[0]
    newline = '\r\n' if '\r\n' in match.group(0) else '\n'
    addition = exact(HERE / 'bluev-test-console-caddy.conf').replace('\r\n', '\n')
    addition = ''.join(match.group('indent') + '  ' + line + newline for line in addition.splitlines()) + newline
    return original[:match.end()] + addition + original[match.end():]

def update_bound_file(expected, replacement, inode):
    # A rename would leave Docker's single-file bind pointing at the old inode.
    import fcntl
    with CADDYFILE.open('r+', encoding='utf-8', newline='') as output:
        fcntl.flock(output, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(os.fstat(output.fileno()).st_ino == inode and CADDYFILE.stat().st_ino == inode,
                'caddy_inode_changed')
        require(sha(output.read().encode()) == expected, 'concurrent_caddy_file_change')
        output.seek(0)
        output.write(replacement)
        output.truncate()
        output.flush()
        os.fsync(output.fileno())
    require(sha(mounted_config().encode()) == sha(replacement.encode()), 'mounted_config_mismatch')

def assert_old(state):
    require(old_containers() == state['containers'], 'old_container_identity_changed')
    require(fingerprint(COMPOSE) == state['compose_sha'], 'old_compose_changed')
    assert_mount()
    require(CADDYFILE.stat().st_ino == state['inode'], 'caddy_inode_changed')

def assert_release(state):
    require(bundle() == state['bundle'], 'deploy_bundle_changed')
    require(manifest(Path(state['release'])) == state['manifest'], 'sidecar_release_changed')
    require(fingerprint(CONFIG / 'service.env') == state['env_sha'], 'sidecar_environment_changed')
    require(json.loads(run(['docker', 'image', 'inspect', state['image']]))[0]['Id'] == state['image'], 'image_changed')
    for name in ('Caddyfile.original', 'Caddyfile.candidate'):
        require(fingerprint(Path(state['backup']) / name) == state[name], 'caddy_backup_changed')
    assert_old(state)

def assert_proxy(state, candidate=False):
    name = 'candidate' if candidate else 'original'
    expected = state['Caddyfile.' + name]
    require(fingerprint(CADDYFILE) == expected and sha(mounted_config().encode()) == expected, 'caddy_file_changed')
    require(active_config() == state[name + '_runtime'], 'caddy_runtime_changed')

def old_health():
    require(request(PUBLIC + '/health')[0] == 200, 'original_health_failed')

def legacy_api_probes():
    result = {}
    for path in ('/admin/api/session', '/admin/api/test/orders'):
        status, body = request(PUBLIC + path)
        require(status == 401, 'legacy_anonymous_boundary_unexpected')
        result[path] = [status, sha(body)]
    return result

def fallback_checks(state):
    # Called while the NEW container has never started. This demonstrates that
    # an unreachable sidecar does not make the existing login/admin page unavailable.
    for path in ('/admin', '/admin/'):
        status, body = request(PUBLIC + path, headers={'Accept': 'text/html', 'Accept-Encoding': 'identity'}, timeout=8)
        require(status == 200 and sha(body) == state['admin_shell_sha'], 'legacy_admin_fallback_failed')
        require(request(PUBLIC + path, method='HEAD', timeout=8)[0] == 200, 'legacy_admin_head_fallback_failed')
    require(legacy_api_probes() == state['legacy_api_probes'], 'legacy_test_api_changed')
    assert_old(state)

def validate_network(network):
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', network), 'invalid_network')
    require(network in inspect(CADDY)['NetworkSettings']['Networks'], 'caddy_not_on_network')
    info = json.loads(run(['docker', 'network', 'inspect', network]))[0]
    require(info.get('Driver') == 'bridge', 'isolated_bridge_required')
    members = info.get('Containers', {})
    candidates = [inspect(item['Name']) for item in members.values() if item['Name'] != CADDY]
    require(any('app_finance' in (value['NetworkSettings']['Networks'].get(network, {}).get('Aliases') or [])
                for value in candidates), 'finance_alias_missing')

def container_exists():
    return NAME in run(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()

def environment(key):
    require(re.fullmatch(r'[A-Za-z0-9_-]{43,128}', key), 'invalid_test_key')
    # Docker --env-file does not strip quotes. These values are deliberately single-line.
    return ('NODE_ENV=production\nHOST=0.0.0.0\nPORT=3114\n'
            'BLUEV_TEST_BASE_URL=https://x.aifu.me/bluev-sandbox\nQUEFA_FINANCE_ORIGIN=http://app_finance:3100\n'
            'PUBLIC_ORIGIN=https://api.quefa.cn\nBLUEV_TEST_KEY=' + key + '\n')

def clean_image_environment(image, *, supplied_by_env_file=False):
    values = json.loads(run(['docker', 'image', 'inspect', image]))[0].get('Config', {}).get('Env') or []
    names = sorted({value.split('=', 1)[0] for value in values})
    require(all(re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name) for name in names), 'image_environment_name_invalid')
    # Clear every baked business credential without copying or printing its value.
    # Docker applies --env AFTER --env-file regardless of argument order. Never
    # add an empty explicit override for a key supplied by our dedicated file.
    supplied = {'NODE_ENV', 'HOST', 'PORT', 'BLUEV_TEST_BASE_URL', 'QUEFA_FINANCE_ORIGIN',
                'PUBLIC_ORIGIN', 'BLUEV_TEST_KEY'} if supplied_by_env_file else set()
    result = [part for name in names if name not in supplied for part in ('--env', name + '=')]
    return result + ['--env', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']

def prepare(args):
    artifact = inputs(args)
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', args.image), 'immutable_local_image_id_required')
    key_sha = fingerprint(Path(args.key_file))
    if STATE.exists():
        state = load(STATE)
        require(state['status'] in {'prepared', 'installed', 'rolled_back'} and
                state['release_id'] == args.release_id and state['artifact_sha'] == args.sha256 and
                state['Caddyfile.original'] == args.proxy_sha256 and state['key_sha'] == key_sha and
                state['image'] == args.image and state['network'] == args.network, 'prepare_state_conflict')
        assert_release(state)
        emit('already_prepared', status=state['status'])
        return
    for path in (ROOT, CONFIG):
        require(not path.exists() and not path.is_symlink(), 'first_install_target_exists')
    require(not container_exists(), 'sidecar_name_in_use')
    assert_mount()
    require(fingerprint(CADDYFILE) == args.proxy_sha256, 'reviewed_caddy_changed')
    validate_network(args.network)
    image = json.loads(run(['docker', 'image', 'inspect', args.image]))[0]
    require(image['Id'] == args.image, 'image_id_mismatch')
    require(not image.get('Config', {}).get('Volumes'), 'image_anonymous_volumes_forbidden')
    # Only an ephemeral NEW container is run to validate the selected runtime.
    require(run(['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop=ALL',
                 '--security-opt=no-new-privileges', *clean_image_environment(args.image),
                 '--entrypoint', 'node', args.image, '--version']).startswith('v24.'),
            'node24_image_required')
    original = exact(CADDYFILE)
    require(mounted_config() == original, 'mounted_caddy_mismatch')
    candidate = candidate_config(original)
    original_runtime = adapt(original)
    require(active_config() == original_runtime, 'original_runtime_not_from_file')
    candidate_runtime = adapt(candidate)
    old = old_containers()
    old_health()
    shell_status, shell = request(PUBLIC + '/admin', headers={'Accept': 'text/html', 'Accept-Encoding': 'identity'})
    require(shell_status == 200 and b'<html' in shell.lower(), 'legacy_admin_shell_unavailable')
    probes = legacy_api_probes()
    with tarfile.open(artifact, 'r:*') as archive:
        archive_members(archive, REQUIRED)
    ROOT.mkdir(mode=0o755)
    backup = ROOT / 'backups' / args.release_id
    backup.mkdir(mode=0o700, parents=True)
    write_new(backup / 'Caddyfile.original', original)
    write_new(backup / 'Caddyfile.candidate', candidate)
    release = ROOT / 'releases' / args.release_id
    state = {'status': 'preparing', 'release_id': args.release_id, 'artifact_sha': args.sha256,
             'release': str(release), 'backup': str(backup), 'bundle': bundle(), 'containers': old,
             'compose_sha': fingerprint(COMPOSE), 'inode': CADDYFILE.stat().st_ino,
             'Caddyfile.original': sha(original.encode()), 'Caddyfile.candidate': sha(candidate.encode()),
             'original_runtime': original_runtime, 'candidate_runtime': candidate_runtime,
             'image': args.image, 'network': args.network, 'key_sha': key_sha,
             'admin_shell_sha': sha(shell), 'legacy_api_probes': probes}
    save(STATE, state)
    extract(artifact, release, REQUIRED)
    require(load(release / 'package.json').get('type') == 'module', 'esm_required')
    CONFIG.mkdir(mode=0o700)
    write_new(CONFIG / 'service.env', environment(protected_key(Path(args.key_file))))
    state['manifest'] = manifest(release)
    state['env_sha'] = fingerprint(CONFIG / 'service.env')
    assert_release(state)
    assert_proxy(state)
    state['status'] = 'prepared'
    save(STATE, state)
    emit('prepared', old_containers_unchanged=True, candidate_validated=True)

def new_container_args(state):
    return ['docker', 'create', '--name', NAME, '--network', state['network'], '--restart', 'unless-stopped',
            '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user', '1000:1000',
            '--pids-limit', '128', '--memory', '192m', '--cpus', '0.35', '--log-driver', 'local',
            '--log-opt', 'max-size=5m', '--log-opt', 'max-file=2',
            *clean_image_environment(state['image'], supplied_by_env_file=True), '--env-file', str(CONFIG / 'service.env'),
            '--mount', 'type=bind,src=' + state['release'] + ',dst=/app,readonly',
            '--workdir', '/app', '--label', 'bluev.release=' + state['release_id'],
            '--entrypoint', 'node', state['image'], 'dist/bluev-test-console-server.js']

def assert_container(state):
    value = inspect(NAME)
    require(value['Id'] == state['container_id'] and value['Image'] == state['image'], 'sidecar_identity_changed')
    require(value['Config'].get('Labels', {}).get('bluev.release') == state['release_id'], 'sidecar_label_changed')
    require(value['HostConfig'].get('ReadonlyRootfs') is True and not value['HostConfig'].get('PortBindings'),
            'sidecar_exposed_or_writable')
    require(len(value['Mounts']) == 1 and value['Mounts'][0]['Source'] == state['release'] and
            value['Mounts'][0]['Destination'] == '/app' and value['Mounts'][0]['RW'] is False, 'sidecar_mount_changed')

def local_checks():
    code = "const r=await fetch('http://127.0.0.1:3114/health');console.log(JSON.stringify({status:r.status,body:await r.json()}));"
    result = json.loads(run(['docker', 'exec', NAME, 'node', '--input-type=module', '-e', code]))
    require(result == {'status': 200, 'body': {'ok': True, 'service': 'bluev-test-console'}}, 'sidecar_health_failed')

def public_checks():
    for path in ('/admin', '/admin/'):
        status, body = request(PUBLIC + path, headers={'Accept': 'text/html', 'Cache-Control': 'no-cache'})
        require(status == 200 and b'bluev-test' in body, 'admin_shell_patch_missing')
    require(request(PUBLIC + '/admin/api/bluev-test/status')[0] == 401, 'anonymous_test_access_allowed')
    require(request(PUBLIC + '/admin/api/session')[0] == 401, 'legacy_session_boundary_changed')

def verify(args=None):
    state = load(STATE)
    require(state['status'] in {'installing', 'installed'}, 'not_installed')
    assert_release(state)
    assert_proxy(state, candidate=True)
    assert_container(state)
    require(inspect(NAME)['State']['Running'] is True, 'sidecar_not_running')
    local_checks()
    wait_ready(public_checks, lambda: (assert_release(state), assert_proxy(state, candidate=True)))
    old_health()
    require(legacy_api_probes() == state['legacy_api_probes'], 'legacy_test_api_changed')
    assert_old(state)
    emit('verified', old_containers_unchanged=True, caddy_inode_preserved=True)

def rollback(args=None):
    state = load(STATE)
    require(state['status'] in {'installing', 'installed', 'rollback_required', 'rolled_back'}, 'rollback_state_invalid')
    assert_release(state)
    current, runtime = fingerprint(CADDYFILE), active_config()
    require(current in {state['Caddyfile.original'], state['Caddyfile.candidate']}, 'concurrent_caddy_file_change')
    require(runtime in {state['original_runtime'], state['candidate_runtime']}, 'concurrent_caddy_runtime_change')
    original = exact(Path(state['backup']) / 'Caddyfile.original')
    require(adapt(original) == state['original_runtime'], 'original_adaptation_changed')
    if current != state['Caddyfile.original']:
        update_bound_file(current, original, state['inode'])
    if runtime != state['original_runtime']:
        reload(original)
    if 'container_id' in state:
        assert_container(state)
        if inspect(NAME)['State']['Running']:
            run(['docker', 'stop', '--time', '20', NAME])
    assert_proxy(state)
    assert_old(state)
    old_health()
    state['status'] = 'rolled_back'
    save(STATE, state)
    emit('rolled_back', old_containers_unchanged=True, x_callbacks_untouched=True)

def apply(args=None):
    state = load(STATE)
    if state['status'] == 'installed':
        verify()
        return
    require(state['status'] in {'prepared', 'rolled_back'}, 'not_prepared')
    assert_release(state)
    assert_proxy(state)
    candidate = exact(Path(state['backup']) / 'Caddyfile.candidate')
    require(adapt(candidate) == state['candidate_runtime'], 'candidate_adaptation_changed')
    validate_network(state['network'])
    if 'container_id' in state:
        assert_container(state)
        require(not inspect(NAME)['State']['Running'], 'unexpected_running_sidecar')
    else:
        require(not container_exists(), 'sidecar_name_taken')
    state['status'] = 'installing'
    save(STATE, state)
    try:
        if 'container_id' not in state:
            state['container_id'] = run(new_container_args(state)).strip()
            require(re.fullmatch(r'[a-f0-9]{64}', state['container_id']), 'container_creation_invalid')
            save(STATE, state)
        assert_container(state)
        assert_proxy(state)
        update_bound_file(state['Caddyfile.original'], candidate, state['inode'])
        reload(candidate)
        wait_ready(lambda: fallback_checks(state), lambda: (assert_release(state), assert_proxy(state, candidate=True)))
        state['fallback_verified'] = True
        save(STATE, state)
        run(['docker', 'start', NAME])
        wait_ready(local_checks, lambda: assert_release(state))
        verify()
        state['status'] = 'installed'
        save(STATE, state)
        emit('installed', only_new_container_started=True)
    except BaseException:
        try:
            rollback()
        except BaseException:
            state['status'] = 'rollback_required'
            save(STATE, state)
            emit('rollback_required', old_containers_restarted=False)
        raise

def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='action', required=True)
    preparation = commands.add_parser('prepare')
    add_prepare_arguments(preparation)
    preparation.add_argument('--image', required=True)
    preparation.add_argument('--network', required=True)
    for name in ('apply', 'verify', 'rollback'):
        commands.add_parser(name)
    locked_main(parser, {'prepare': prepare, 'apply': apply, 'verify': verify, 'rollback': rollback},
                '/run/lock/bluev-test-console-deploy.lock')

if __name__ == '__main__':
    main()
