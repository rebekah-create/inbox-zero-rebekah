# Server Rebuild Runbook

EC2: t4g.small, us-east-1, free until Dec 2026  
Domain: inbox.tdfurn.com (Route 53, hosted zone Z19CXOEZPIWEYP)  
All secrets stored in AWS Parameter Store under `/inbox-zero/`

## Steps to rebuild from scratch

1. **Launch new EC2 t4g.small** (Ubuntu 24.04, us-east-1), attach the `inbox-zero-role` IAM role, assign the `inbox-key` key pair

2. **Reassign Elastic IP** 13.223.138.202 to the new instance in EC2 console

3. **Install dependencies**
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-plugin awscli jq
   sudo usermod -aG docker ubuntu
   newgrp docker
   ```

4. **Set up app directory**
   ```bash
   sudo mkdir -p /opt/inbox-zero
   sudo chown ubuntu:ubuntu /opt/inbox-zero
   ```

5. **Copy deploy files from this repo**
   ```bash
   cp deploy/load-secrets.sh /opt/inbox-zero/load-secrets.sh
   cp docker/docker-compose.yml /opt/inbox-zero/docker-compose.yml  # or scp from local
   chmod +x /opt/inbox-zero/load-secrets.sh
   ```

6. **Install systemd service**
   ```bash
   sudo cp deploy/inbox-zero.service /etc/systemd/system/inbox-zero.service
   sudo systemctl daemon-reload
   sudo systemctl enable inbox-zero.service
   sudo systemctl start inbox-zero.service
   ```

7. **Restore Postgres backup** (from S3 bucket inbox-zero-backups-253610008894)
   ```bash
   # Wait for containers to be healthy first
   aws s3 cp s3://inbox-zero-backups-253610008894/latest.dump /tmp/latest.dump
   docker exec -i inbox-zero-postgres pg_restore -U inboxzero -d inboxzero /tmp/latest.dump
   ```

8. **Re-install nginx + SSL** (see original setup notes)

9. **Verify Gmail watch** is still active — check EmailAccount.watchEmailsExpirationDate in DB
