"""Optional authenticated fixed-egress gateway. Run behind HTTPS.

GATEWAY_SECRET must match OUTBOUND_GATEWAY_SECRET. Bind to loopback by default.
X quote/IP checks use /v1/request. ZovoCard card management uses /v1/cards.
No merchant checkout or X payment endpoints are permitted.
"""
import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("GATEWAY_SECRET", "")
if len(SECRET) < 32:
    raise SystemExit("Set GATEWAY_SECRET to at least 32 characters")
NONCES = {}
LOCK = threading.Lock()
ALLOWED_HEADERS = {"authorization", "cookie", "x-csrf-token", "x-twitter-auth-type", "x-twitter-active-user", "x-twitter-client-language", "referer", "user-agent", "accept"}
X_PATH = "/i/api/graphql/Se1Bp6zcNnuXYXRecV2qLA/useSubscriptionProductDetailsByRestIdQuery"


def card_target(data):
    """Strict card-management allowlist. Never proxy arbitrary URLs or redirects."""
    url = urllib.parse.urlsplit(data["url"])
    method = data.get("method", "GET")
    if (url.scheme != "https" or url.hostname not in ("zovocard.com", "sandbox.zovocard.com")
            or url.username or url.password or url.fragment or url.port not in (None, 443)):
        raise ValueError()
    path = url.path.removeprefix("/openapi/v1")
    if url.path != "/openapi/v1" + path:
        raise ValueError()
    query = urllib.parse.parse_qs(url.query, keep_blank_values=True, strict_parsing=True) if url.query else {}
    if any(k not in ("page", "page_size", "sync") or len(v) != 1 or not v[0].isdigit()
           for k, v in query.items()):
        raise ValueError()
    if query.get("sync", ["0"])[0] != "0":
        raise ValueError()
    if method == "GET":
        if path not in ("/balance", "/products", "/cards") and not re.fullmatch(r"/cards/[1-9][0-9]*/(transactions|recharges)", path):
            raise ValueError()
        if data.get("body"):
            raise ValueError()
        body = None
    elif method == "POST" and path in ("/cards/open", "/cards/recharge") and not url.query:
        # Enabling writes requires a separate server switch as well as admin UI consent.
        if os.environ.get("CARD_WRITES_ENABLED") != "true":
            raise ValueError()
        body = data["body"].encode("utf-8")
        if len(body) > 4096 or not isinstance(json.loads(body), dict):
            raise ValueError()
    else:
        raise ValueError()
    allowed = {"x-api-key", "x-app-id", "content-type", "idempotency-key"}
    headers = {k: v for k, v in data.get("headers", {}).items() if k.lower() in allowed}
    if method == "POST" and not any(k.lower() == "idempotency-key" and re.fullmatch(r"[A-Za-z0-9._:-]{1,80}", v) for k, v in headers.items()):
        raise ValueError()
    return urllib.request.Request(data["url"], data=body, headers=headers, method=method)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass  # Never log credentials or request bodies.

    def reply(self, status, body, content_type="application/json", signature=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if signature:
            self.send_header("X-Response-Signature", signature)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            if self.path not in ("/v1/request", "/v1/cards"):
                raise ValueError()
            size = int(self.headers.get("Content-Length", "0"))
            if not 1 <= size <= 16384:
                raise ValueError()
            raw = self.rfile.read(size)
            ts, nonce = self.headers.get("X-Timestamp", ""), self.headers.get("X-Nonce", "")
            if abs(time.time() - int(ts)) > 300 or not 16 <= len(nonce) <= 128:
                raise ValueError()
            canonical = "\n".join(["POST", self.path, ts, nonce, hashlib.sha256(raw).hexdigest()])
            expected = hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(expected, self.headers.get("X-Signature", "")):
                raise ValueError()
            with LOCK:
                for key in list(NONCES):
                    if NONCES[key] < time.time():
                        del NONCES[key]
                if nonce in NONCES:
                    raise ValueError()
                NONCES[nonce] = time.time() + 600
            data = json.loads(raw)
            if self.path == "/v1/cards":
                request = card_target(data)
                # Explicit empty ProxyHandler prevents environment proxy inheritance.
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                try:
                    response = opener.open(request, timeout=20)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    body = response.read(524289)
                    if len(body) > 524288:
                        raise ValueError()
                    signed = ".".join([ts, nonce, str(response.status)]).encode() + b"." + body
                    signature = hmac.new(SECRET.encode(), signed, hashlib.sha256).hexdigest()
                    self.reply(response.status, body, signature=signature)
                return
            url = urllib.parse.urlsplit(data["url"])
            if url.scheme != "https" or url.username or url.password or url.fragment or url.port not in (None, 443):
                raise ValueError()
            if not ((url.hostname == "x.com" and url.path == X_PATH) or (url.hostname == "ipinfo.io" and url.path == "/json" and not url.query)):
                raise ValueError()
            proxy = data["proxy"]
            if proxy["protocol"] != "http":
                self.reply(422, b'{"error":"gateway_supports_http_only"}')
                return
            host, port = proxy["host"], int(proxy["port"])
            if not 1 <= port <= 65535:
                raise ValueError()
            addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
            if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
                raise ValueError()
            user = urllib.parse.quote(str(proxy.get("username", "")), safe="")
            password = urllib.parse.quote(str(proxy.get("password", "")), safe="")
            auth = (user + ":" + password + "@") if user else ""
            proxy_url = "http://" + auth + host + ":" + str(port)
            headers = {k: v for k, v in data.get("headers", {}).items() if k.lower() in ALLOWED_HEADERS}
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy_url, "https": proxy_url}), NoRedirect())
            request = urllib.request.Request(data["url"], headers=headers, method="GET")
            try:
                response = opener.open(request, timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                body = response.read(256001)
                if len(body) > 256000:
                    raise ValueError()
                self.reply(response.status, body, "application/json")
        except (ValueError, KeyError, TypeError, json.JSONDecodeError):
            self.reply(400, b'{"error":"request_rejected"}')
        except Exception:
            self.reply(502, b'{"error":"upstream_unavailable"}')


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("GATEWAY_PORT", "8790"))), Handler).serve_forever()
