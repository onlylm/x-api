"""X host only: independent sandbox, no legacy restart or database restore."""
from __future__ import annotations
import argparse
import os
from pathlib import Path
import re
import sqlite3
import tarfile
from bluev_deploy_common import *

HERE = Path(__file__).resolve().parent
ROOT = Path('/opt/x-bluev-sandbox')
CONFIG = Path('/etc/x-bluev-sandbox')
DATA = Path('/srv/x-bluev-sandbox')
STATE = ROOT / 'deploy-state.json'
SITE = Path('/etc/nginx/sites-available/xgift')
SNIPPET = Path('/etc/nginx/snippets/x-bluev-sandbox.conf')
UNIT = Path('/etc/systemd/system/x-bluev-sandbox.service')
SERVICE = 'x-bluev-sandbox'
NODE = '/opt/node/bin/node'
PUBLIC = 'https://x.aifu.me/bluev-sandbox'
FILES = ['deploy-bluev-sandbox.py', 'bluev_deploy_common.py', 'configure-bluev-sandbox.mjs',
         'x-bluev-sandbox.service', 'bluev-sandbox-nginx.conf']
REQUIRED = ['package.json', 'package-lock.json', 'dist/bluev-sandbox-server.js']
OLD_FILES = [Path(value) for value in ('/etc/xgift/service.env', '/etc/x-partner-gateway/service.env',
    '/etc/x-partner-gateway/products.json', '/etc/systemd/system/xgift.service',
    '/etc/systemd/system/x-partner-gateway.service', '/etc/nginx/snippets/x-partner-gateway.conf')]
OLD_GATES = [Path('/srv/x-partner-gateway/control') / name for name in ('sales.enabled', 'workers.enabled')]

def bundle():
    return {name: fingerprint(HERE / name) for name in FILES}

def old_baseline():
    services = ['xgift', 'x-partner-gateway', 'nginx']
    if Path('/etc/systemd/system/x-platform-orders.service').exists():
        services.append('x-platform-orders')
    require(all(not path.exists() and not path.is_symlink() for path in OLD_GATES), 'old_gates_must_stay_closed')
    products = load(Path('/etc/x-partner-gateway/products.json'))
    require(products and all(product.get('enabled') is False for product in products), 'old_products_must_stay_closed')
    return {'services': {name: service_identity(name) for name in services},
            'links': {name: str((Path('/opt') / name / 'current').resolve(strict=True))
                      for name in services if name != 'nginx'},
            'files': {str(path): fingerprint(path) for path in OLD_FILES}}

def assert_old(state):
    require(old_baseline() == state['old'], 'old_service_or_configuration_changed')

def old_health():
    for url, headers in [('http://127.0.0.1:8791/healthz', {'Host': 'x.aifu.me'}),
                         ('http://127.0.0.1:3110/health', None)]:
        require(request(url, headers=headers)[0] == 200, 'old_health_failed')

def candidate_site(original):
    require('/bluev-sandbox' not in original and str(SNIPPET) not in original, 'sandbox_route_already_exists')
    require(original.count('include /etc/nginx/snippets/x-partner-gateway.conf;') == 1
            and original.count('proxy_pass http://127.0.0.1:8791;') == 1, 'legacy_proxy_unexpected')
    matches = list(re.finditer(r'^(?P<indent>[ \t]*)location[ \t]+/[ \t]*\{[ \t]*\r?$', original, re.MULTILINE))
    require(len(matches) == 1 and 'x.aifu.me' in original, 'nginx_location_ambiguous')
    match = matches[0]
    newline = '\r\n' if match.group(0).endswith('\r') else '\n'
    insertion = match.group('indent') + 'include ' + str(SNIPPET) + ';' + newline + newline
    return original[:match.start()] + insertion + original[match.start():]

def assert_release(state):
    require(bundle() == state['bundle'], 'deploy_bundle_changed')
    require(manifest(Path(state['release'])) == state['manifest'], 'release_changed')
    require(fingerprint(CONFIG / 'service.env') == state['env_sha'], 'sandbox_environment_changed')
    for name in ('nginx.original', 'nginx.candidate'):
        require(fingerprint(Path(state['backup']) / name) == state[name], 'proxy_backup_changed')
    assert_old(state)

def prepare(args):
    artifact = inputs(args)
    key_hash = fingerprint(Path(args.key_file))
    if STATE.exists():
        state = load(STATE)
        require(state['status'] in {'prepared', 'installed', 'rolled_back'} and
                state['release_id'] == args.release_id and state['artifact_sha'] == args.sha256 and
                state['nginx.original'] == args.proxy_sha256 and state['key_file_sha'] == key_hash,
                'prepare_state_conflict')
        assert_release(state)
        emit('already_prepared', status=state['status'])
        return
    for path in (ROOT, CONFIG, DATA, UNIT, SNIPPET):
        require(not path.exists() and not path.is_symlink(), 'first_install_target_exists')
    require(fingerprint(SITE) == args.proxy_sha256, 'reviewed_nginx_changed')
    require(run([NODE, '--version']).startswith('v24.'), 'node24_required')
    unused_service(SERVICE)
    port_free(3112)
    baseline = old_baseline()
    old_health()
    original = exact(SITE)
    candidate = candidate_site(original)
    with tarfile.open(artifact, 'r:*') as archive:
        archive_members(archive, REQUIRED)
    import pwd
    try:
        pwd.getpwnam('xbluevsandbox')
    except KeyError:
        run(['useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', 'xbluevsandbox'])
    else:
        raise DeployError('sandbox_user_already_exists')
    user = pwd.getpwnam('xbluevsandbox')
    ROOT.mkdir(mode=0o755)
    backup = ROOT / 'backups' / args.release_id
    backup.mkdir(mode=0o700, parents=True)
    write_new(backup / 'nginx.original', original)
    write_new(backup / 'nginx.candidate', candidate)
    release = ROOT / 'releases' / args.release_id
    state = {'status': 'preparing', 'release_id': args.release_id, 'release': str(release),
             'backup': str(backup), 'artifact_sha': args.sha256, 'bundle': bundle(), 'old': baseline,
             'nginx.original': sha(original.encode()), 'nginx.candidate': sha(candidate.encode()),
             'site_mode': SITE.stat().st_mode & 0o777, 'key_file_sha': key_hash}
    save(STATE, state)
    extract(artifact, release, REQUIRED)
    require(load(release / 'package.json').get('type') == 'module', 'esm_required')
    run([NODE, '--check', str(release / 'dist/bluev-sandbox-server.js')])
    run(['/opt/node/bin/npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', str(release)], timeout=300)
    CONFIG.mkdir(mode=0o700)
    run([NODE, str(HERE / 'configure-bluev-sandbox.mjs'), str(Path(args.key_file))])
    DATA.mkdir(mode=0o700)
    os.chown(DATA, user.pw_uid, user.pw_gid)
    # Only the NEW sales gate is opened. The backend registers only repair and fulfillment workers.
    write_new(DATA / 'sales.enabled', 'isolated-admin-integration-test\n')
    os.chown(DATA / 'sales.enabled', user.pw_uid, user.pw_gid)
    state['manifest'] = manifest(release)
    state['env_sha'] = fingerprint(CONFIG / 'service.env')
    state['gate_sha'] = fingerprint(DATA / 'sales.enabled')
    assert_release(state)
    require(fingerprint(SITE) == state['nginx.original'], 'nginx_changed_during_prepare')
    state['status'] = 'prepared'
    save(STATE, state)
    emit('prepared', old_services_unchanged=True, old_secrets_exported=False)

def local_checks():
    status, body = request('http://127.0.0.1:3112/health')
    require(status == 200 and load_json(body) == {'success': True, 'service': 'bluev-sandbox', 'isolated': True},
            'sandbox_health_invalid')
    require(request('http://127.0.0.1:3112/internal/bluev-test/status')[0] == 401, 'sandbox_key_not_required')
    for path in ('/admin', '/api/v1/checkout/products', '/v1/orders'):
        require(request('http://127.0.0.1:3112' + path)[0] == 404, 'unexpected_sandbox_route')

def load_json(data):
    return json.loads(data)

def public_checks():
    require(request(PUBLIC + '/internal/bluev-test/status')[0] in {401, 403}, 'public_key_or_ip_not_required')
    for path in ('/health', '/admin', '/api/v1/checkout/products'):
        require(request(PUBLIC + path)[0] == 404, 'sandbox_private_route_exposed')
    status, _ = request(PUBLIC + '/callbacks/alipay', 'POST', b'out_trade_no=invalid-probe',
                        {'Content-Type': 'application/x-www-form-urlencoded'})
    require(status == 400, 'invalid_callback_not_rejected')

def verify(args=None):
    state = load(STATE)
    require(state['status'] in {'installing', 'installed'}, 'not_installed')
    assert_release(state)
    require(fingerprint(SITE) == state['nginx.candidate'], 'nginx_changed')
    require(fingerprint(UNIT) == state['bundle']['x-bluev-sandbox.service'] and
            fingerprint(SNIPPET) == state['bundle']['bluev-sandbox-nginx.conf'], 'new_unit_or_route_changed')
    require((ROOT / 'current').is_symlink() and (ROOT / 'current').resolve() == Path(state['release']), 'release_link_changed')
    require(service_identity(SERVICE)['FragmentPath'] == str(UNIT), 'unexpected_sandbox_unit')
    local_checks()
    wait_ready(public_checks, lambda: assert_release(state))
    old_health()
    assert_old(state)
    emit('verified', old_services_unchanged=True, no_payment_created=True)

def has_orders():
    database = DATA / 'bluev-sandbox.sqlite'
    if not database.exists():
        return False
    require(database.is_file() and not database.is_symlink(), 'sandbox_database_invalid')
    connection = sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        # Include reserved checkout intents: a remote payment may exist before the local order row.
        for name in ('orders', 'checkout_intents', 'bluev_test_requests'):
            if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone():
                if connection.execute('SELECT 1 FROM ' + name + ' LIMIT 1').fetchone():
                    return True
        return False
    finally:
        connection.close()

def close_sales(state):
    gate, disabled = DATA / 'sales.enabled', DATA / 'sales.disabled-by-deploy'
    if gate.exists() or gate.is_symlink():
        require(fingerprint(gate) == state['gate_sha'] and not disabled.exists() and not disabled.is_symlink(),
                'sandbox_sales_gate_changed')
        gate.rename(disabled)
    else:
        require(fingerprint(disabled) == state['gate_sha'], 'sandbox_disabled_gate_changed')

def restore_empty_sales(state):
    gate, disabled = DATA / 'sales.enabled', DATA / 'sales.disabled-by-deploy'
    if gate.exists() or gate.is_symlink():
        require(fingerprint(gate) == state['gate_sha'], 'sandbox_sales_gate_changed')
    else:
        require(not has_orders() and fingerprint(disabled) == state['gate_sha'], 'sandbox_cannot_reopen_sales')
        disabled.rename(gate)

def rollback(args=None):
    state = load(STATE)
    if state['status'] == 'rolled_back':
        assert_release(state)
        require(fingerprint(SITE) == state['nginx.original'], 'nginx_changed_after_rollback')
        require(service_identity(SERVICE, active=False).get('MainPID') == '0', 'sandbox_restarted_after_rollback')
        emit('already_rolled_back')
        return
    require(state['status'] in {'installing', 'installed', 'rollback_required'}, 'rollback_state_invalid')
    assert_release(state)
    current = fingerprint(SITE)
    require(current in {state['nginx.original'], state['nginx.candidate']}, 'concurrent_nginx_change')
    if UNIT.exists():
        require(fingerprint(UNIT) == state['bundle']['x-bluev-sandbox.service'], 'sandbox_unit_changed')
    close_sales(state)
    if has_orders():
        state['status'] = 'rollback_required'
        save(STATE, state)
        raise DeployError('sandbox_orders_exist_sales_closed_callback_and_workers_preserved')
    # Drain the NEW server before the second check, closing the check/stop race.
    # If an admitted request persisted an intent, restart only this service and
    # retain its callback route; never roll its database back.
    if UNIT.exists():
        run(['systemctl', 'stop', SERVICE])
        if has_orders():
            run(['systemctl', 'start', SERVICE])
            state['status'] = 'rollback_required'
            save(STATE, state)
            raise DeployError('sandbox_inflight_request_preserved_sales_closed')
    if current == state['nginx.candidate']:
        original = exact(Path(state['backup']) / 'nginx.original')
        atomic(SITE, original, state['site_mode'])
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
    if UNIT.exists():
        run(['systemctl', 'disable', SERVICE])
    old_health()
    assert_old(state)
    state['status'] = 'rolled_back'
    save(STATE, state)
    emit('rolled_back', new_database_preserved=True, old_services_unchanged=True)

def apply(args=None):
    state = load(STATE)
    if state['status'] == 'installed':
        verify()
        return
    require(state['status'] in {'prepared', 'rolled_back'}, 'not_prepared')
    assert_release(state)
    require(fingerprint(SITE) == state['nginx.original'], 'nginx_changed_before_apply')
    require(not has_orders(), 'resume_requires_empty_sandbox')
    restore_empty_sales(state)
    port_free(3112)
    old_health()
    for path, source in [(UNIT, HERE / 'x-bluev-sandbox.service'), (SNIPPET, HERE / 'bluev-sandbox-nginx.conf')]:
        if path.exists() or path.is_symlink():
            require(fingerprint(path) == fingerprint(source), 'resume_target_changed')
    current = ROOT / 'current'
    if current.exists() or current.is_symlink():
        require(current.is_symlink() and current.resolve() == Path(state['release']), 'resume_current_changed')
    state['status'] = 'installing'
    save(STATE, state)
    try:
        if not current.is_symlink():
            os.symlink(state['release'], current)
        if not UNIT.exists():
            write_new(UNIT, exact(HERE / 'x-bluev-sandbox.service'), 0o644)
        run(['systemd-analyze', 'verify', str(UNIT)])
        run(['systemctl', 'daemon-reload'])
        run(['systemctl', 'enable', '--now', SERVICE])
        wait_ready(local_checks, lambda: assert_release(state))
        require(fingerprint(SITE) == state['nginx.original'], 'nginx_changed_before_route')
        if not SNIPPET.exists():
            write_new(SNIPPET, exact(HERE / 'bluev-sandbox-nginx.conf'), 0o644)
        atomic(SITE, exact(Path(state['backup']) / 'nginx.candidate'), state['site_mode'])
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
        verify()
        state['status'] = 'installed'
        save(STATE, state)
        emit('installed', only_new_service_started=True)
    except BaseException:
        try:
            rollback()
        except BaseException:
            state['status'] = 'rollback_required'
            save(STATE, state)
            emit('rollback_required', old_services_restarted=False)
        raise

def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest='action', required=True)
    add_prepare_arguments(commands.add_parser('prepare'))
    for name in ('apply', 'verify', 'rollback'):
        commands.add_parser(name)
    locked_main(parser, {'prepare': prepare, 'apply': apply, 'verify': verify, 'rollback': rollback},
                '/run/lock/x-bluev-sandbox-deploy.lock')

if __name__ == '__main__':
    main()
