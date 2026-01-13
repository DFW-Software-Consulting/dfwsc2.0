Great call. If you want **one ngrok instance to front multiple apps** on the Dell, run **ngrok as a systemd service** with a single config file that defines **many tunnels**. That way you can add/remove apps just by editing one YAML, and all tunnels come up at boot.

Here’s the clean, production-y setup:

# 1) Install & auth ngrok (one time)

```bash
# Install (Ubuntu/Debian)
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt update && sudo apt install -y ngrok

# Add your token
ngrok config add-authtoken 2y1VbbO4UjqyqEJpCAji0jbrlrA_5uMFCpmmqrVRw7qKcSswJ
```

# 2) Create a single ngrok config with multiple tunnels

```bash
sudo tee /etc/ngrok/ngrok.yml >/dev/null <<'YAML'
version: 3
region: us
log: stdout
web_addr: 127.0.0.1:4040

# If you have reserved static domains, set them per tunnel via "domain:".
# Otherwise ngrok will assign random URLs on each restart.

tunnels:
  stripe_portal:
    proto: http
    # If your app is in Docker but exposed to host on 3000, keep localhost:3000:
    addr: http://127.0.0.1:3000
    # domain: your-stripe-portal.ngrok-free.app
    # Optional protection if this is publicly reachable:
    # basic_auth:
    #   - "dfwsc:REPLACE_WITH_STRONG_PASSWORD"

  mailhog_ui:
    proto: http
    addr: http://127.0.0.1:8025
    # domain: mailhog-dfwsc.ngrok-free.app
    # DO NOT expose without basic_auth if it holds real mail.

  adminer:
    proto: http
    addr: http://127.0.0.1:8080
    # domain: adminer-dfwsc.ngrok-free.app
    # Strongly recommend enabling basic_auth or do not expose to internet.

  # Example: Next service on port 4000
  property_link:
    proto: http
    addr: http://127.0.0.1:4000
    # domain: propertylink-dfwsc.ngrok-free.app

  # Example: TCP tunnel (e.g., SSH). Static TCP requires a paid plan.
  ssh:
    proto: tcp
    addr: 127.0.0.1:22
YAML

# (Optional) lock down permissions
sudo chmod 600 /etc/ngrok/ngrok.yml
```

> If your app containers *aren’t* publishing host ports, change `addr:` to the container’s host-mapped port (expose them in your app’s docker-compose), or run ngrok inside Docker on the same network. Keeping ngrok pointing to **localhost ports** is simplest for a “hub” machine.

# 3) Run ngrok as a background service (starts at boot)

```bash
sudo tee /etc/systemd/system/ngrok.service >/dev/null <<'UNIT'
[Unit]
Description=ngrok multi-tunnel service
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env ngrok start --all --config /etc/ngrok/ngrok.yml
Restart=on-failure
User=jeremy
WorkingDirectory=/home/jeremy

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now ngrok
sudo systemctl status ngrok --no-pager
```

# 4) Get your URLs

* Browser dashboard: [http://localhost:4040](http://localhost:4040)
* CLI:

```bash
curl -s http://127.0.0.1:4040/api/tunnels \
| sed -nE 's/.*"name":"([^"]+)".*"public_url":"(https:[^"]+)".*/\1 -> \2/p'
```

You’ll see something like:

```
stripe_portal -> https://brave-otter-1234.ngrok-free.app
mailhog_ui    -> https://...ngrok-free.app
adminer       -> https://...ngrok-free.app
property_link -> https://...ngrok-free.app
ssh           -> tcp://0.tcp.ngrok.io:xxxxx
```

# 5) Keep URLs stable (optional but recommended)

* Reserve static domains in the ngrok dashboard.
* Add `domain: your-subdomain.ngrok-free.app` under each tunnel.
* Then restart:

```bash
sudo systemctl restart ngrok
```

# 6) Security tips (important)

* Anything you expose is public. Use `basic_auth:` on sensitive UIs (Adminer, Mailhog), or don’t tunnel them.
* Prefer unique strong passwords per tunnel.
* For APIs that need secrets (e.g., Stripe webhooks), allowlist event sources if possible.

---

## When to use Docker instead

Stick with this **system service** approach since you want one ngrok to serve many apps. If later you want per-project isolation, you can still add a tiny `docker-compose.ngrok.yml` inside that project. Both patterns can coexist.

Want me to add `basic_auth` lines now for Adminer/Mailhog and give you a one-liner to rotate those creds?
