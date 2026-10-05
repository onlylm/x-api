"""Quefa /bluev relay only. Do not rebuild/restart any trading container."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.request

ROOT = Path('/opt/merchant-gateway')
CADDYFILE = ROOT / 'Caddyfile'
COMPOSE = ROOT / 'compose.yaml'
CADDY = 'merchant-gateway-caddy-1'
CONTAINER_CONFIG = '/etc/caddy/Caddyfile'
SCRIPT = Path(__file__).resolve()
STATE = SCRIPT.parent / 'caddy-route-state.json'
PUBLIC = 'https://api.quefa.cn'
DIRECT = 'https://x.aifu.me/partner'
INSERTION = '''  # BEGIN isolated-bluev-relay
  handle /bluev/* {
    route {
      uri strip_prefix /bluev
      rewrite * /partner{uri}
      reverse_proxy https://x.aifu.me {
        header_up Host x.aifu.me
      }
    }
  }
  # END isolated-bluev-relay

'''


class RouteError(RuntimeError):
    pass


def require(ok, code):
    if not ok:
        raise RouteError(code)


def emit(event, **data):
    print(json.dumps(dict(event=event, **data), ensure_ascii=False), flush=True)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical_sha(data):
    return sha(json.dumps(data, sort_keys=True, separators=(',', ':')).encode())


def run(args, *, input_text=None, timeout=45):
    result = subprocess.run(args, input=input_text, text=True, capture_output=True, timeout=timeout)
    # No process output is echoed; Caddy configuration may contain authentication data.
    require(result.returncode == 0, 'command_failed:' + Path(args[0]).name)
    return result.stdout


def atomic_write(path, text):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                         prefix='.' + path.name + '.', delete=False) as output:
            temporary = Path(output.name)
            os.chmod(temporary, 0o600)
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def write_new(path, text):
    with path.open('x', encoding='utf-8') as output:
        os.chmod(path, 0o600)
        output.write(text)
        output.flush()
        os.fsync(output.fileno())


def save_state(state):
    atomic_write(STATE, json.dumps(state, indent=2) + '\n')


def make_candidate(original):
    require('/bluev' not in original and 'isolated-bluev-relay' not in original,
            'bluev_route_already_present')
    matches = list(re.finditer(r'^api\.quefa\.cn\s*\{[ \t]*\r?\n', original, re.MULTILINE))
    require(len(matches) == 1, 'api_site_missing_or_ambiguous')
    site = matches[0]
    # The reviewed configuration has one explicit top-level route containing all
    # legacy handles. A site-level handle would run after that route's fallback.
    routes = list(re.finditer(r'^(?P<indent>[ \t]+)route[ \t]*\{[ \t]*\r?\n', original, re.MULTILINE))
    require(len(routes) == 1 and routes[0].start() > site.end(), 'legacy_route_missing_or_ambiguous')
    route = routes[0]
    prefix = original[site.end():route.start()]
    require(not re.search(r'^\S', prefix, re.MULTILINE), 'legacy_route_outside_api_site')
    insertion = route.end()
    nested = ''.join(route.group('indent') + line if line.strip() else line
                     for line in INSERTION.splitlines(keepends=True))
    return original[:insertion] + nested + original[insertion:]


def identity(name):
    raw = json.loads(run(['docker', 'inspect', name]))[0]
    require(raw['State']['Running'] is True, 'container_not_running')
    return {'id': raw['Id'], 'image': raw['Image'], 'started_at': raw['State']['StartedAt']}


def containers():
    names = sorted(run(['docker', 'ps', '--format', '{{.Names}}']).splitlines())
    selected = [name for name in names if name.startswith('merchant-gateway-')]
    require(CADDY in selected and len(selected) >= 3, 'expected_containers_missing')
    return {name: identity(name) for name in selected}


def assert_mount():
    raw = json.loads(run(['docker', 'inspect', CADDY]))[0]
    mounts = [item for item in raw['Mounts'] if item['Destination'] == CONTAINER_CONFIG]
    require(len(mounts) == 1 and mounts[0]['Type'] == 'bind'
            and mounts[0]['Source'] == str(CADDYFILE), 'unexpected_caddy_config_mount')
    # The existing deployment uses a single-file bind mount. Preserve its inode.
    require(not CADDYFILE.is_symlink() and CADDYFILE.is_file(), 'caddyfile_not_regular')


def mounted_config():
    return run(['docker', 'exec', CADDY, 'cat', CONTAINER_CONFIG])


def adapt_validate(config):
    return json.loads(run(['docker', 'exec', '-i', CADDY, 'caddy', 'adapt', '--config', '-',
                           '--adapter', 'caddyfile', '--validate'], input_text=config))


def active_config_sha():
    active = json.loads(run(['docker', 'exec', CADDY, 'wget', '-qO-',
                            'http://127.0.0.1:2019/config/']))
    return canonical_sha(active)


def fetch(url, method='GET', data=None, headers=None):
    request = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read(65536)
    except urllib.error.HTTPError as error:
        return error.code, error.read(65536)


def health(base):
    status, body = fetch(base + '/health')
    require(status == 200 and json.loads(body).get('success') is True, 'health_failed')


def relay_checks(base):
    health(base)
    code, _ = fetch(base + '/api/v1/checkout/products')
    require(code == 401, 'checkout_auth_not_enforced')
    for path in ('/admin', '/admin/api/products', '/dev', '/internal/reports/orders.csv'):
        code, _ = fetch(base + path)
        require(code == 404, 'private_route_exposed')
    code, _ = fetch(base + '/payment-qr/nonexistent-order.png?token=invalid%2B%2F%3D')
    require(code == 404, 'invalid_qr_not_rejected')
    code, _ = fetch(base + '/callbacks/alipay', method='POST', data=b'out_trade_no=invalid-probe',
                    headers={'Content-Type': 'application/x-www-form-urlencoded'})
    require(code == 400, 'invalid_callback_not_rejected')


def assert_static_baseline(state, expected_hash, expected_runtime):
    require(sha(SCRIPT.read_bytes()) == state['script_sha256'], 'script_changed')
    require(sha(COMPOSE.read_bytes()) == state['compose_sha256'], 'compose_changed')
    require(containers() == state['containers'], 'container_identity_changed')
    assert_mount()
    require(CADDYFILE.stat().st_ino == state['caddyfile_inode'], 'caddyfile_inode_changed')
    require(sha(CADDYFILE.read_bytes()) == expected_hash, 'caddyfile_changed')
    require(sha(mounted_config().encode()) == expected_hash, 'mounted_caddyfile_mismatch')
    require(active_config_sha() == expected_runtime, 'caddy_runtime_changed')


def update_bound_file(expected_hash, replacement, expected_inode):
    # Atomic rename breaks single-file Docker bind visibility. Hold an inode lock,
    # compare contents, update in place, fsync, then validate container visibility.
    import fcntl
    with CADDYFILE.open('r+', encoding='utf-8', newline='') as output:
        fcntl.flock(output, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(os.fstat(output.fileno()).st_ino == expected_inode
                and CADDYFILE.stat().st_ino == expected_inode, 'caddyfile_inode_changed')
        require(sha(output.read().encode()) == expected_hash, 'concurrent_caddyfile_change')
        output.seek(0)
        output.write(replacement)
        output.truncate()
        output.flush()
        os.fsync(output.fileno())
    require(sha(mounted_config().encode()) == sha(replacement.encode()), 'mounted_candidate_not_visible')


def reload_config(config):
    run(['docker', 'exec', '-i', CADDY, 'caddy', 'reload', '--config', '-', '--adapter', 'caddyfile'],
        input_text=config)


def prepare(args):
    require(not STATE.exists(), 'route_state_exists')
    require(re.fullmatch(r'[a-z0-9][a-z0-9-]{5,63}', args.release_id), 'invalid_release_id')
    require(re.fullmatch(r'[a-f0-9]{64}', args.caddy_sha256), 'invalid_expected_sha')
    assert_mount()
    original = CADDYFILE.read_text(encoding='utf-8')
    require(sha(original.encode()) == args.caddy_sha256, 'reviewed_caddy_baseline_changed')
    require(mounted_config() == original, 'mounted_original_mismatch')
    candidate = make_candidate(original)
    locked_containers = containers()
    original_runtime = canonical_sha(adapt_validate(original))
    require(active_config_sha() == original_runtime, 'existing_runtime_not_from_file')
    candidate_runtime = canonical_sha(adapt_validate(candidate))
    health(PUBLIC)
    relay_checks(DIRECT)
    backup = ROOT / 'backups' / ('bluev-route-' + args.release_id)
    require(not backup.exists(), 'route_backup_exists')
    backup.mkdir(mode=0o700, parents=True)
    os.chmod(backup, 0o700)
    write_new(backup / 'Caddyfile.original', original)
    write_new(backup / 'Caddyfile.candidate', candidate)
    state = {'status': 'prepared', 'backup': str(backup), 'script_sha256': sha(SCRIPT.read_bytes()),
             'containers': locked_containers, 'compose_sha256': sha(COMPOSE.read_bytes()),
             'original_sha256': sha(original.encode()), 'candidate_sha256': sha(candidate.encode()),
             'original_runtime_sha256': original_runtime, 'candidate_runtime_sha256': candidate_runtime,
             'caddyfile_inode': CADDYFILE.stat().st_ino}
    assert_static_baseline(state, state['original_sha256'], original_runtime)
    save_state(state)
    emit('prepared', candidate_validated=True, containers_unchanged=True, trading_containers_restarted=False,
         original_sha256=state['original_sha256'], candidate_sha256=state['candidate_sha256'])


def rollback_after_failure(state):
    require(containers() == state['containers'], 'rollback_container_identity_changed')
    require(sha(COMPOSE.read_bytes()) == state['compose_sha256'], 'rollback_compose_changed')
    current = sha(CADDYFILE.read_bytes())
    runtime = active_config_sha()
    require(current in {state['original_sha256'], state['candidate_sha256']}, 'rollback_concurrent_file_change')
    require(runtime in {state['original_runtime_sha256'], state['candidate_runtime_sha256']},
            'rollback_concurrent_runtime_change')
    original = (Path(state['backup']) / 'Caddyfile.original').read_text(encoding='utf-8')
    require(sha(original.encode()) == state['original_sha256'], 'rollback_backup_changed')
    adapt_validate(original)
    if current != state['original_sha256']:
        update_bound_file(current, original, state['caddyfile_inode'])
    reload_config(original)
    assert_static_baseline(state, state['original_sha256'], state['original_runtime_sha256'])
    health(PUBLIC)
    state['status'] = 'rolled_back'
    save_state(state)
    emit('rolled_back', containers_unchanged=True, databases_changed=False)


def verify():
    state = json.loads(STATE.read_text())
    require(state['status'] in {'applying', 'applied'}, 'route_not_applied')
    assert_static_baseline(state, state['candidate_sha256'], state['candidate_runtime_sha256'])
    health(PUBLIC)
    relay_checks(PUBLIC + '/bluev')
    emit('verified', original_health=True, bluev_health=True, private_routes_blocked=True,
         containers_unchanged=True)


def apply():
    state = json.loads(STATE.read_text())
    require(state['status'] == 'prepared', 'route_not_prepared')
    assert_static_baseline(state, state['original_sha256'], state['original_runtime_sha256'])
    candidate = (Path(state['backup']) / 'Caddyfile.candidate').read_text(encoding='utf-8')
    require(sha(candidate.encode()) == state['candidate_sha256'], 'candidate_backup_changed')
    require(canonical_sha(adapt_validate(candidate)) == state['candidate_runtime_sha256'],
            'candidate_adaptation_changed')
    health(PUBLIC)
    relay_checks(DIRECT)
    state['status'] = 'applying'
    save_state(state)
    try:
        assert_static_baseline(state, state['original_sha256'], state['original_runtime_sha256'])
        update_bound_file(state['original_sha256'], candidate, state['caddyfile_inode'])
        reload_config(candidate)
        verify()
        state['status'] = 'applied'
        save_state(state)
        emit('applied', canonical_base=PUBLIC + '/bluev', databases_changed=False,
             trading_containers_restarted=False)
    except BaseException:
        try:
            rollback_after_failure(state)
        except BaseException:
            state['status'] = 'rollback_requires_review'
            save_state(state)
            emit('rollback_requires_review', databases_changed=False)
        raise


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='action', required=True)
    preparation = commands.add_parser('prepare')
    preparation.add_argument('--release-id', required=True)
    preparation.add_argument('--caddy-sha256', required=True)
    commands.add_parser('apply')
    commands.add_parser('verify')
    args = parser.parse_args()
    require(os.geteuid() == 0, 'root_required')
    import fcntl
    with Path('/run/lock/merchant-gateway-bluev-route.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            if args.action == 'prepare':
                prepare(args)
            elif args.action == 'apply':
                apply()
            else:
                verify()
        except Exception as error:
            emit('failed', error_type=type(error).__name__,
                 code=str(error) if isinstance(error, RouteError) else 'inspect_server_privately')
            raise SystemExit(1)


if __name__ == '__main__':
    main()
