#!/usr/bin/env python3
"""
HTTPS server for Camera VLM Guide.
Required for iOS camera access over LAN (getUserMedia needs HTTPS).
"""

import http.server
import ssl
import os
import socket

PORT = 8443
DIR = os.path.dirname(os.path.abspath(__file__))

os.chdir(DIR)

# Get local IP
def get_local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

handler = http.server.SimpleHTTPRequestHandler

context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(
    certfile=os.path.join(DIR, "cert.pem"),
    keyfile=os.path.join(DIR, "key.pem"),
)

server = http.server.HTTPServer(("0.0.0.0", PORT), handler)
server.socket = context.wrap_socket(server.socket, server_side=True)

local_ip = get_local_ip()
print(f"""
╔══════════════════════════════════════════════════╗
║        Camera VLM Guide — HTTPS Server           ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  Local:   https://localhost:{PORT}               ║
║  LAN:     https://{local_ip}:{PORT}          ║
║                                                  ║
║  📱 iPhone 访问方法:                              ║
║  1. 打开 Safari，输入上面的 LAN 地址              ║
║  2. 遇到证书警告时，点击 "高级" → "继续访问"      ║
║  3. 允许摄像头权限                                ║
║                                                  ║
╚══════════════════════════════════════════════════╝
""")

try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\n🛑 Server stopped.")
    server.server_close()
