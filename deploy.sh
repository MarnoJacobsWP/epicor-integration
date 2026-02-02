#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Epicor Integration Deployment...${NC}"
echo "==================================================="

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: package.json not found. Please run from project root.${NC}"
    exit 1
fi

# Stop the service if running
echo -e "${YELLOW}Stopping existing service...${NC}"
sudo systemctl stop epicor-integration 2>/dev/null || true

# Install/Update dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
npm ci --only=production

# Create necessary directories
echo -e "${YELLOW}Creating directories...${NC}"
mkdir -p logs
mkdir -p tmp

# Set permissions
echo -e "${YELLOW}Setting permissions...${NC}"
chmod -R 755 logs
chmod -R 755 tmp

# Copy environment file if exists
if [ -f ".env.production" ] && [ ! -f ".env" ]; then
    echo -e "${YELLOW}Copying production environment file...${NC}"
    cp .env.production .env
    echo -e "${GREEN}Please update .env with your actual credentials${NC}"
fi

# Reload systemd
echo -e "${YELLOW}Reloading systemd...${NC}"
sudo systemctl daemon-reload

# Start the service
echo -e "${YELLOW}Starting service...${NC}"
sudo systemctl start epicor-integration

# Check service status
echo -e "${YELLOW}Checking service status...${NC}"
sleep 3
sudo systemctl status epicor-integration --no-pager

# Run health check
echo -e "${YELLOW}Running health check...${NC}"
sleep 2
if curl -f http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo -e "${YELLOW}Checking logs...${NC}"
    sudo journalctl -u epicor-integration -n 20 --no-pager
fi

echo -e "${GREEN}Deployment completed!${NC}"