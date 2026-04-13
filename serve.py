"""Levn basit HTTP sunucu — sandbox-uyumlu.

Python'un http.server CLI'si argparse default'unda os.getcwd() çağırıyor ve
cwd erişilemeyen bir sandbox path'indeyse PermissionError atıyor. Bu script
cwd'yi önce explicit olarak bu dizine ayarlayıp ondan sonra sunucuyu başlatır.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)

# http.server CLI'sini manuel taklit et
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8765"))
print(f"Levn sunucu: http://localhost:{PORT}/ui/  (dizin: {ROOT})", flush=True)

server = ThreadingHTTPServer(("127.0.0.1", PORT), SimpleHTTPRequestHandler)
try:
    server.serve_forever()
except KeyboardInterrupt:
    server.shutdown()
