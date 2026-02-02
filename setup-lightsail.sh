#!/bin/bash

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}AWS Lightsail Setup Script for Epicor Integration${NC}"
echo "=========================================================="

# Update system
echo -e "${YELLOW}Updating system packages...${NC}"
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
echo -e "${YELLOW}Installing Node.js 20.x...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install MongoDB
echo -e "${YELLOW}Installing MongoDB...${NC}"
sudo apt install -y wget gnupg curl

wget -qO - https://www.mongodb.org/static/pgp/server-7.0.asc | sudo tee /etc/apt/trusted.gpg.d/mongodb.asc
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt update
sudo apt install -y mongodb-org

# Start MongoDB
echo -e "${YELLOW}Starting MongoDB...${NC}"
sudo systemctl start mongod
sudo systemctl enable mongod

# Create application directory
echo -e "${YELLOW}Creating application directory...${NC}"
sudo mkdir -p /home/bitnami/htdocs/epicor-integration
sudo mkdir -p /home/bitnami/htdocs/epicor-integration/logs
sudo mkdir -p /home/bitnami/htdocs/epicor-integration/tmp

# Set permissions
echo -e "${YELLOW}Setting permissions...${NC}"
sudo chown -R bitnami:bitnami /home/bitnami/htdocs/epicor-integration
sudo chmod -R 755 /home/bitnami/htdocs/epicor-integration

# Create systemd service file
echo -e "${YELLOW}Creating systemd service...${NC}"
sudo tee /etc/systemd/system/epicor-integration.service > /dev/null << 'EOF'
[Unit]
Description=Epicor to HubSpot Integration Service
After=network.target mongod.service
Wants=network.target

[Service]
Type=simple
User=bitnami
Group=bitnami
WorkingDirectory=/home/bitnami/htdocs/epicor-integration
Environment=NODE_ENV=production
Environment=PATH=/usr/bin:/usr/local/bin
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=epicor-integration

# Security
ProtectSystem=full
ReadWritePaths=/home/bitnami/htdocs/epicor-integration/logs
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

# Enable firewall
echo -e "${YELLOW}Configuring firewall...${NC}"
sudo ufw allow ssh
sudo ufw allow 3000
sudo ufw --force enable
sudo ufw status

echo -e "${GREEN}Setup completed!${NC}"
echo ""
echo "Next steps:"
echo "1. Clone your repository:"
echo "   cd /home/bitnami/htdocs/epicor-integration"
echo "   git clone <your-repo-url> ."
echo ""
echo "2. Configure environment:"
echo "   cp .env.production .env"
echo "   nano .env  # Add your credentials"
echo ""
echo "3. Deploy:"
echo "   ./deploy.sh"
echo ""
echo "4. Enable service:"
echo "   sudo systemctl enable epicor-integration"