#!/usr/bin/env python3
"""
Static dev server for the INCOIS Ocean3D frontend.

Identical to `python -m http.server` except it sends `Cache-Control: no-store`.
That one header matters here: browsers keep an in-memory cache of ES modules
that a soft reload does not revalidate, so editing js/scene.js and pressing F5
can silently serve you the previous version. Without this you have to remember
to hard-reload (Ctrl+Shift+R) after every single edit.

    python serve.py [port]        # default 8791
"""

import functools
import http.server
import os
import sys

# PORT env var wins so a launcher can assign a free port; then an explicit
# argument; then the default. Without the env check, two people running the
# app at once collide on a hardcoded port.
PORT = int(os.environ.get("PORT") or (sys.argv[1] if len(sys.argv) > 1 else 8791))
ROOT = os.path.dirname(os.path.abspath(__file__))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler) as httpd:
        print(f"Ocean3D serving {ROOT}")
        print(f"  http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
