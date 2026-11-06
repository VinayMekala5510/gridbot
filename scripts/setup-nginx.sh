#!/usr/bin/env bash
# One-time server setup: nginx HTTPS proxy for the dashboard.
# Creates a self-signed certificate for the server IP if no certificate exists yet.
#   bash scripts/setup-nginx.sh <public-ip>
set -euo pipefail
IP="${1:?usage: setup-nginx.sh <public-ip>}"
cd "$(dirname "$0")/.."

export DEBIAN_FRONTEND=noninteractive
sudo apt-get install -y -qq nginx > /dev/null
sudo mkdir -p /etc/nginx/ssl /var/www/acme
if [ ! -s /etc/nginx/ssl/gridbot.crt ]; then
  sudo openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout /etc/nginx/ssl/gridbot.key -out /etc/nginx/ssl/gridbot.crt \
    -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" 2> /dev/null
  sudo chmod 600 /etc/nginx/ssl/gridbot.key
  echo "Created self-signed certificate for $IP"
fi
sudo cp deploy/nginx-gridbot.conf /etc/nginx/sites-available/gridbot
sudo ln -sf /etc/nginx/sites-available/gridbot /etc/nginx/sites-enabled/gridbot
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable --now nginx > /dev/null 2>&1
sudo systemctl reload nginx
echo "nginx serving https://$IP"
