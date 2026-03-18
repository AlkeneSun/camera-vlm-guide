# Camera VLM Guide 📸

Browser-based mobile camera app that guides users to photograph objects in a forced sequence. Uses AI vision (VLM) to identify objects in real-time.

## Features

- 📱 Mobile-first design, optimized for iOS Safari/Chrome
- 🎯 Sequential object detection with strict ordering
- 🤖 VLM-powered real-time image recognition (Qwen3.5-35B)
- 🎨 Dark theme with glassmorphism UI
- 📊 Progress tracking with detection history
- ⚡ Configurable FPS, confidence threshold

## Quick Start

### Local (Desktop)

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

### LAN Access (iPhone)

Camera requires HTTPS on iOS. Generate a self-signed certificate and use the included HTTPS server:

```bash
# Generate certificate (one-time)
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=YOUR_IP"

# Start HTTPS server
python3 server.py
# Open https://YOUR_IP:8443 on iPhone Safari
```

## Tech Stack

- Pure HTML / CSS / JavaScript (no framework)
- VLM API: Qwen/Qwen3.5-35B-A3B via ModelScope
- Python `http.server` for local serving

## License

MIT
