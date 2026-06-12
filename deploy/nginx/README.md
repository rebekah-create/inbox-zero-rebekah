# nginx config + Cloudflare Origin CA cert install

Target state for the box (`i-0ddd8a31e870a696e`, Ubuntu, arm64):

- `/etc/nginx/sites-available/inbox` = `deploy/nginx/inbox.conf` (this directory)
- `/etc/ssl/cloudflare/inbox.tdfurn.com.pem` + `.key` = the Cloudflare Origin CA
  cert + private key, fetched from SSM Parameter Store (`/inbox-zero-tls/*`,
  written there by `deploy/terraform/cloudflare.tf`).

The instance role (`inbox-zero-role`) already has `AmazonSSMReadOnlyAccess`, so
the box can read both parameters itself -- the secret key never touches the
laptop. All commands below run from the laptop (PowerShell) and execute on the
box via SSM.

Run these at CLOUDFLARE-CUTOVER.md Stage 4 (after `tofu apply` has created the
Origin CA cert, and after DNS cutover so Cloudflare is already proxying).

## 1. Install the Origin CA cert + key from SSM

```powershell
aws ssm send-command --region us-east-1 --instance-ids i-0ddd8a31e870a696e `
  --document-name AWS-RunShellScript --comment "install cloudflare origin cert" `
  --parameters 'commands=["sudo mkdir -p /etc/ssl/cloudflare","aws ssm get-parameter --name /inbox-zero-tls/origin-cert --region us-east-1 --query Parameter.Value --output text | sudo tee /etc/ssl/cloudflare/inbox.tdfurn.com.pem > /dev/null","aws ssm get-parameter --name /inbox-zero-tls/origin-key --with-decryption --region us-east-1 --query Parameter.Value --output text | sudo tee /etc/ssl/cloudflare/inbox.tdfurn.com.key > /dev/null","sudo chown root:root /etc/ssl/cloudflare/inbox.tdfurn.com.pem /etc/ssl/cloudflare/inbox.tdfurn.com.key","sudo chmod 0600 /etc/ssl/cloudflare/inbox.tdfurn.com.pem /etc/ssl/cloudflare/inbox.tdfurn.com.key","sudo head -1 /etc/ssl/cloudflare/inbox.tdfurn.com.pem"]'
```

Check the result (expect `-----BEGIN CERTIFICATE-----` as the last output line):

```powershell
aws ssm get-command-invocation --region us-east-1 --instance-id i-0ddd8a31e870a696e `
  --command-id <CommandId-from-previous-output>
```

## 2. Install the nginx site config

Option A -- push over the existing SSH access (simplest; key `~/.ssh/inbox_key`):

```powershell
scp -i $env:USERPROFILE\.ssh\inbox_key deploy\nginx\inbox.conf ubuntu@inbox.tdfurn.com:/tmp/inbox.conf
ssh -i $env:USERPROFILE\.ssh\inbox_key ubuntu@inbox.tdfurn.com "sudo cp /etc/nginx/sites-available/inbox /etc/nginx/sites-available/inbox.bak && sudo mv /tmp/inbox.conf /etc/nginx/sites-available/inbox"
```

Option B -- pure SSM, base64-encoding the file into the command (use if SSH is
ever closed):

```powershell
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("deploy\nginx\inbox.conf"))
$payload = @{ commands = @(
  "sudo cp /etc/nginx/sites-available/inbox /etc/nginx/sites-available/inbox.bak",
  "echo $b64 | base64 -d | sudo tee /etc/nginx/sites-available/inbox > /dev/null"
) } | ConvertTo-Json
Set-Content -Path params.json -Value $payload -Encoding ascii
aws ssm send-command --region us-east-1 --instance-ids i-0ddd8a31e870a696e `
  --document-name AWS-RunShellScript --comment "push nginx config" `
  --parameters file://params.json
Remove-Item params.json
```

## 3. Validate and reload nginx

```powershell
aws ssm send-command --region us-east-1 --instance-ids i-0ddd8a31e870a696e `
  --document-name AWS-RunShellScript --comment "reload nginx" `
  --parameters 'commands=["sudo nginx -t","sudo systemctl reload nginx"]'
```

`nginx -t` failing leaves the old config live (reload is never reached).
Roll back with:

```powershell
aws ssm send-command --region us-east-1 --instance-ids i-0ddd8a31e870a696e `
  --document-name AWS-RunShellScript --comment "rollback nginx config" `
  --parameters 'commands=["sudo cp /etc/nginx/sites-available/inbox.bak /etc/nginx/sites-available/inbox","sudo nginx -t","sudo systemctl reload nginx"]'
```

## 4. Verify

- `https://inbox.tdfurn.com` loads through Cloudflare with no 526 (Invalid SSL
  certificate) errors -- 526 means Cloudflare could not validate the origin
  cert under SSL mode Full (strict).
- Direct origin check from the box itself (the Origin CA cert is NOT publicly
  trusted, so `-k` is expected):

```powershell
aws ssm send-command --region us-east-1 --instance-ids i-0ddd8a31e870a696e `
  --document-name AWS-RunShellScript --comment "verify origin tls" `
  --parameters 'commands=["curl -sk -o /dev/null -w \"%{http_code} %{ssl_verify_result}\" --resolve inbox.tdfurn.com:443:127.0.0.1 https://inbox.tdfurn.com/"]'
```

## Rollback to Let's Encrypt

The old certbot material stays at `/etc/letsencrypt/live/inbox.tdfurn.com/`.
`inbox.conf` contains a commented-out fallback block pointing at it -- swap the
`ssl_certificate` lines back, ensure port 80 is open in the security group
(`lock_origin_to_cloudflare = false`), re-enable the certbot timer
(`sudo systemctl enable --now certbot.timer`), and reload nginx.
