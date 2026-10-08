"""Sync only the two Nginx HTML entry roots to the already-running X release.

Does not install code, migrate databases, or restart application services.
"""
import argparse
import hashlib
from html.parser import HTMLParser
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

SNIPPET = Path('/etc/nginx/snippets/x-platform-orders.conf')
CURRENT = Path('/opt/xgift/current')
SERVICES = ('xgift', 'x-partner-gateway', 'x-platform-orders', 'x-bluev-sandbox', 'nginx')
GUARDS = (Path('/etc/nginx/sites-available/xgift'),
          Path('/etc/nginx/snippets/x-partner-gateway.conf'),
          Path('/etc/nginx/snippets/x-bluev-sandbox.conf'),
          Path('/etc/xgift/service.env'), Path('/etc/x-partner-gateway/service.env'),
          Path('/etc/x-platform-orders/service.env'), Path('/etc/x-bluev-sandbox/service.env'))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=8)
    require(result.returncode == 0, 'command_failed:' + args[0])
    return result.stdout.strip()


def snapshot():
    identities = {name: command('systemctl', 'show', name, '-p', 'MainPID',
                                '-p', 'ActiveState', '-p', 'ExecMainStartTimestampMonotonic')
                  for name in SERVICES}
    require(all('ActiveState=active' in value and 'MainPID=0\n' not in value + '\n'
                for value in identities.values()), 'service_not_active')
    return (identities, {str(path): sha(path.read_bytes()) for path in GUARDS},
            str(CURRENT.resolve(strict=True)))


def candidate(original, target):
    root = target.as_posix()
    require(re.fullmatch(r'/opt/xgift/releases/[a-f0-9]{40}/services/xgift/dist', root),
            'invalid_target')
    require(original.count('location = / {') == 1 and
            original.count('location = /index.html {') == 1, 'ambiguous_html_entries')
    pattern = r'(?m)^(    root )(/opt/(?:x-platform-orders/releases/[a-f0-9]{40}/ui|xgift/releases/[a-f0-9]{40}/services/xgift/dist))(;)$'
    matches = list(re.finditer(pattern, original))
    require(len(matches) == 2 and matches[0][2] == matches[1][2], 'unexpected_html_roots')
    # Roots must belong to the two HTML entry blocks, never an API/static location.
    for match, location in zip(matches, ('location = / {', 'location = /index.html {')):
        before = original[:match.start()]
        require(before.rfind(location) == before.rfind('location '), 'root_outside_html_entry')
    return re.sub(pattern, lambda match: match[1] + root + match[3], original)


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'script':
            require(bool(values.get('src')), 'inline_script_not_allowed')
            self.urls.append(values['src'])
        elif tag == 'link':
            self.urls.append(values.get('href', ''))


def assets(index):
    parser = Assets()
    parser.feed(index.decode('utf-8'))
    require(any(url.endswith('.js') for url in parser.urls) and
            any(url.endswith('.css') for url in parser.urls), 'missing_js_or_css')
    require(all(re.fullmatch(r'/assets/[A-Za-z0-9_.-]+\.(?:js|css|woff2)|/favicon\.svg', url)
                for url in parser.urls), 'unexpected_asset_url')
    return parser.urls


def request(path, backend=False, method='GET'):
    connection = http.client.HTTPConnection('127.0.0.1', 8791, timeout=2) if backend else \
        http.client.HTTPSConnection('x.aifu.me', timeout=2)
    try:
        connection.request(method, path, headers={'Host': 'x.aifu.me',
                           'Cache-Control': 'no-cache', 'Accept': 'text/html'})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def atomic(data, mode):
    with tempfile.NamedTemporaryFile(dir=SNIPPET.parent, prefix='.xgift-ui-', delete=False) as file:
        temporary = Path(file.name)
        os.chmod(temporary, mode)
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    try:
        os.replace(temporary, SNIPPET)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True)
    parser.add_argument('--snippet-sha256', required=True)
    args = parser.parse_args()
    require(os.geteuid() == 0, 'root_required')
    require(re.fullmatch('[a-f0-9]{40}', args.release) is not None, 'invalid_revision')
    require(re.fullmatch('[a-f0-9]{64}', args.snippet_sha256) is not None, 'invalid_hash')
    release = Path('/opt/xgift/releases') / args.release
    require(CURRENT.resolve(strict=True) == release, 'release_not_current')
    target = release / 'services/xgift/dist'
    require(target.resolve(strict=True) == target, 'symlinked_dist_not_allowed')
    require(SNIPPET.is_file() and not SNIPPET.is_symlink(), 'snippet_not_regular')
    original = SNIPPET.read_bytes()
    require(sha(original) == args.snippet_sha256, 'snippet_baseline_changed')
    proposed = candidate(original.decode('utf-8'), target).encode('utf-8')
    require(proposed != original, 'already_synced')
    index = (target / 'index.html').read_bytes()
    urls = assets(index)
    expected = {url: (target / url.lstrip('/')).read_bytes() for url in urls}
    for url, body in expected.items():
        require(request(url, backend=True)[::2] == (200, body), 'backend_asset_mismatch')
    # Preserve the existing immutable platform UI assets and read-only API route.
    old_assets = re.findall(r'location \^~ (/platform-admin-ui/[a-f0-9]{40}/)', original.decode())
    require(len(old_assets) == 1, 'old_asset_route_missing')
    old_url = old_assets[0] + 'favicon.svg'
    old_response = request(old_url)
    require(old_response[0] == 200, 'old_asset_unavailable')
    before = snapshot()
    stamp = str(time.time_ns())
    backup = SNIPPET.parent / ('x-platform-orders-ui-backup-' + stamp + '.txt')
    with backup.open('xb') as file:
        os.chmod(backup, 0o600)
        file.write(original)
    require(snapshot() == before and SNIPPET.read_bytes() == original, 'concurrent_change')
    mode = SNIPPET.stat().st_mode & 0o777
    try:
        atomic(proposed, mode)
        command('nginx', '-t')
        command('systemctl', 'reload', 'nginx')
        for attempt in range(8):
            require(snapshot() == before and SNIPPET.read_bytes() == proposed, 'concurrent_change')
            results = [request(path) for path in ('/', '/index.html')]
            if all(status == 200 and body == index and headers.get('Cache-Control') == 'no-store'
                   for status, headers, body in results):
                break
            time.sleep(1)
        else:
            raise RuntimeError('public_html_not_updated')
        for url, body in expected.items():
            require(request(url)[::2] == (200, body), 'public_asset_mismatch')
        require(request(old_url)[::2] == old_response[::2], 'old_asset_changed')
        require(request('/api/admin/platform-orders')[0] == 401, 'admin_auth_changed')
        require(request('/api/admin/platform-orders', method='POST')[0] == 405, 'readonly_api_changed')
        require(request('/healthz', backend=True)[0] == 200, 'x_health_failed')
        require(snapshot() == before and SNIPPET.read_bytes() == proposed, 'postcheck_changed')
    except Exception:
        if SNIPPET.read_bytes() == proposed:
            atomic(original, mode)
            command('nginx', '-t')
            command('systemctl', 'reload', 'nginx')
        raise
    print(json.dumps({'admin_ui_release': args.release, 'public_html_and_assets': 'matched',
                      'application_services': 'not_restarted', 'old_assets_and_api': 'preserved',
                      'configuration': 'unchanged_except_two_html_roots', 'backup': str(backup)}))


if __name__ == '__main__':
    main()
