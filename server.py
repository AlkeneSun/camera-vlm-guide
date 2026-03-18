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

import json

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        if self.path == '/log':
            content_length = int(self.headers.get('Content-Length', 0))
            post_data = self.rfile.read(content_length)
            try:
                data = json.loads(post_data.decode('utf-8'))
                print(f"\033[94m📊 [Browser] {data.get('message', '')}\033[0m")
            except Exception:
                pass
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
        else:
            self.send_error(404)

    def log_message(self, format, *args):
        # 忽略 /log 接口的默认访问日志，避免刷屏
        if len(args) > 0 and 'POST /log' in args[0]:
            return
        super().log_message(format, *args)

handler = CustomHandler

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
