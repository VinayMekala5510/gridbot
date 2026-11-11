#!/usr/bin/env bash
# One-time server setup: trusted Let's Encrypt certificate for the server's IP address.
# Uses the "shortlived" profile (≈6-day certificates, required for IP addresses) and
# renews automatically twice a day via /etc/cron.d/gridbot-acme when < 3 days remain.
# Running this accepts the Let's Encrypt Subscriber Agreement.
#   bash scripts/setup-tls.sh <public-ip>
set -euo pipefail
IP="${1:?usage: setup-tls.sh <public-ip>}"

sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq acme.sh > /dev/null
sudo mkdir -p /var/www/acme
sudo acme.sh --issue --server letsencrypt -d "$IP" -w /var/www/acme --cert-profile shortlived --days 3
sudo acme.sh --install-cert -d "$IP" --ecc \
  --key-file /etc/nginx/ssl/gridbot.key --fullchain-file /etc/nginx/ssl/gridbot.crt \
  --reloadcmd "systemctl reload nginx"
sudo chmod 600 /etc/nginx/ssl/gridbot.key
echo "17 3,15 * * * root /usr/bin/acme.sh --cron --home /root/.acme.sh > /var/log/acme-renew.log 2>&1" \
  | sudo tee /etc/cron.d/gridbot-acme > /dev/null
sudo chmod 644 /etc/cron.d/gridbot-acme
sudo openssl x509 -in /etc/nginx/ssl/gridbot.crt -noout -issuer -enddate
