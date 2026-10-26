"""The one TLS context every HTTP client in this app uses.

THE BUG THIS REPLACED, because it stopped every run for three days: httpx builds its own SSL
context per `Client`, which means OpenSSL opening certifi's `cacert.pem` from disk each time.
In the frozen .exe that file lives in PyInstaller's `%TEMP%\\_MEIxxxxxx` extraction folder, and
when OpenSSL cannot read it — temp cleanup removed it under a long-open window, antivirus locked
it, a non-ASCII TEMP path — the client cannot even be constructed. The window showed
`SSLError: [X509] BIO lib (_ssl.c:4354)`, every hourly run died the same way before fetching a
single page, and the dashboard went stale.

So no CA file is read at all: `truststore` verifies against the Windows certificate store, the
same one Chrome and Edge trust. If it is unavailable, certifi's bundle is read into memory once,
here, at import — later fetches never touch the filesystem again.
"""

from __future__ import annotations

import ssl


def _context() -> ssl.SSLContext:
    try:
        import truststore

        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    except Exception:
        import certifi

        with open(certifi.where(), encoding="ascii") as f:
            return ssl.create_default_context(cadata=f.read())


SSL_CONTEXT = _context()
