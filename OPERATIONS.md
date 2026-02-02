# Epicor Integration - Operations Guide

## Server Information
- **Instance**: AWS LightSail Debian
- **IP**: [YOUR_STATIC_IP]
- **SSH User**: bitnami
- **SSH Key**: [KEY_NAME].ppk (Windows) / .pem (Mac/Linux)
- **Application Directory**: `/home/bitnami/htdocs/epicor-integration/`

## Service Management

### Service Name
- **Service**: `epicor-integration`
- **Database**: `mongod`

### Common Commands

```bash
# Start service
sudo systemctl start epicor-integration

# Stop service
sudo systemctl stop epicor-integration

# Restart service
sudo systemctl restart epicor-integration

# Check status
sudo systemctl status epicor-integration

# View logs
sudo journalctl -u epicor-integration -f
sudo journalctl -u epicor-integration -n 100
sudo journalctl -u epicor-integration --since "1 hour ago"

# Enable on boot
sudo systemctl enable epicor-integration