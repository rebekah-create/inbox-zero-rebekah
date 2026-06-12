# Cloudflare Cutover + Observability Runbook

Staged migration of tdfurn.com DNS to Cloudflare (free plan), origin TLS to a
Cloudflare Origin CA cert, EC2 origin lockdown to Cloudflare edge IPs, and
nginx log shipping to CloudWatch with paging alarms.

Everything is driven by `deploy/terraform/` (OpenTofu). Two feature flags
gate the dangerous steps; defaults are safe:

| Flag | Default | Flipped at |
|------|---------|-----------|
| `dns_cutover` | `false` | Stage 3 -- repoints registrar NS to Cloudflare |
| `lock_origin_to_cloudflare` | `false` | Stage 5 -- closes 80/443-to-world |

Do the stages IN ORDER. Each has verification and rollback. Nothing in
Stage 1-2 affects live traffic.

---

## Stage 0 -- Prerequisites (manual, one-time)

1. The Cloudflare account **already exists** -- account ID
   `3b8da3715845965764758f419faf7054` (it manages
   topdrawerfurniturestore.com via the tdf-email project's OpenTofu stack).
   Do NOT create a new account. The account ID is already filled in
   `deploy/terraform/terraform.tfvars.example`; copy it into
   `deploy/terraform/terraform.tfvars` as `cloudflare_account_id` (account
   IDs are not secret).
2. Add the **tdfurn.com zone via the dashboard** (Add site -> tdfurn.com ->
   Free plan). API tokens in this account have failed zone creation before
   (see tdf-email HANDOFF.md); the established pattern is dashboard-create,
   then import into Tofu. Cloudflare shows its assigned nameservers
   immediately -- do **NOT** change the registrar NS yet; that is Stage 3.
   Note the **Zone ID** from the zone's Overview page (right-hand column) --
   Stage 1 needs it for the import block.
3. Mint a **NEW API token** (My Profile -> API Tokens -> Create Token ->
   Custom). The two existing tokens in this account do NOT have sufficient
   scopes -- the tdf-email token lacks Zone-create / Zone Settings / WAF /
   SSL-Certs edit, and the forager token is Workers-only. Do not try to
   reuse them. Permissions:
   - Zone -> Zone -> Edit
   - Zone -> DNS -> Edit
   - Zone -> Zone Settings -> Edit
   - Zone -> Firewall Services -> Edit  (covers WAF custom rulesets)
   - Zone -> SSL and Certificates -> Edit  (covers Origin CA cert issuance)
   - Zone Resources: "Include -> All zones from an account ->
     <this account>". Per the tdf-email HANDOFF.md, specific-zone scoping
     has caused issues in this account -- use the account-wide scope.
4. (Fallback only) Retrieve the **Origin CA Key** (Manage Account -> API Keys
   -> Origin CA Key, starts with `v1.0-`). Provider v5 cannot combine it with
   an API token ("must provide only one of api_token, api_user_service_key"),
   and the Cloudflare API has accepted API tokens on the Origin CA endpoints
   since Aug 2022 -- so the token from step 3 is the primary path. Keep the
   Origin CA Key noted somewhere safe in case token-based issuance ever
   regresses.
5. Export for tofu (PowerShell):

   ```powershell
   $env:CLOUDFLARE_API_TOKEN = "<token>"
   ```

6. **Bot Fight Mode must remain OFF** (Security -> Bots). It is off by
   default. Reason: on the free plan, Bot Fight Mode cannot be skipped by WAF
   custom rules, so it would challenge/block Google Pub/Sub webhook POSTs to
   `/api/google/webhook` with no way to exempt them.
7. SNS: after Stage 1's apply, AWS emails a "Subscription Confirmation" link
   to rebekah@trueocean.com. **Click it** -- until then alarms fire into the
   void.

---

## Stage 1 -- Apply (no traffic impact)

Pre-apply checklist:

1. Both flags `false` in `terraform.tfvars`.
2. Fill the zone ID from Stage 0 step 2 into the commented-out `import` block
   above `resource "cloudflare_zone" "tdfurn"` in
   `deploy/terraform/cloudflare.tf` and uncomment it -- the apply adopts the
   dashboard-created zone instead of trying to create one (zone creation via
   API token fails in this account).

```powershell
cd deploy/terraform
tofu init
tofu plan -out plan.out    # review: CF zone import+records+settings+WAF+origin
                           # cert, SG imports, prefix lists, log groups,
                           # alarms, SNS
tofu apply plan.out
```

This imports the dashboard-created Cloudflare zone and creates all DNS records
(mirroring Route 53),
zone settings (SSL strict, always-HTTPS, TLS 1.2 floor), the webhook WAF skip
rule, the Origin CA cert (stored in SSM `/inbox-zero-tls/*`), the CloudWatch
log groups / metric filters / alarms / SNS topic, and imports the existing
security group, its 3 rules, and the 2 click-ops EC2 status alarms into state.

DNS is NOT live on Cloudflare yet -- the registrar still points at Route 53.

### Verify -- diff Cloudflare answers against Route 53 BEFORE cutover

Get the assigned nameservers:

```powershell
tofu output cloudflare_name_servers   # e.g. anna.ns.cloudflare.com, bob.ns.cloudflare.com
```

Query the Cloudflare nameservers DIRECTLY and compare with the live (Route 53)
answers. PowerShell:

```powershell
$cf = "anna.ns.cloudflare.com"   # <- one of the tofu output values
$checks = @(
  @{n="tdfurn.com"; t="A"},
  @{n="tdfurn.com"; t="MX"},
  @{n="tdfurn.com"; t="TXT"},
  @{n="_dmarc.tdfurn.com"; t="TXT"},
  @{n="4m7azekszg5fxambtddoppt4ifyjiwhu._domainkey.tdfurn.com"; t="CNAME"},
  @{n="524mkcl56qosviyizi7yqwrsl237ipqq._domainkey.tdfurn.com"; t="CNAME"},
  @{n="ncgqxncrpk2gdwrgdbwr5hxkqmibvaev._domainkey.tdfurn.com"; t="CNAME"},
  @{n="resend._domainkey.tdfurn.com"; t="TXT"},
  @{n="mail.tdfurn.com"; t="MX"}, @{n="mail.tdfurn.com"; t="TXT"},
  @{n="send.tdfurn.com"; t="MX"}, @{n="send.tdfurn.com"; t="TXT"},
  @{n="claims.tdfurn.com"; t="CNAME"}, @{n="qb.tdfurn.com"; t="CNAME"},
  @{n="www.tdfurn.com"; t="CNAME"}, @{n="inbox.tdfurn.com"; t="A"}
)
foreach ($c in $checks) {
  "=== $($c.n) $($c.t) ==="
  "  CF : " + ((Resolve-DnsName $c.n -Type $c.t -Server $cf -ErrorAction SilentlyContinue | Out-String).Trim())
  "  R53: " + ((Resolve-DnsName $c.n -Type $c.t -Server ns-701.awsdns-23.net -ErrorAction SilentlyContinue | Out-String).Trim())
}
```

(dig equivalent from Git Bash: `dig +short @anna.ns.cloudflare.com tdfurn.com MX`
etc.)

Expected differences -- everything else must match exactly:

- `inbox.tdfurn.com A` from Cloudflare returns **Cloudflare anycast IPs**, not
  13.223.138.202. That is the proxy working as designed.
- `claims`/`qb` answer as CNAME -> `*.cloudfront.net` on Cloudflare, where
  Route 53 returned A/AAAA alias answers. Resolving them recursively must
  still land on CloudFront.
- TXT quoting/order cosmetics.

Pay special attention to MX, SPF TXT, `_dmarc`, and the three `_domainkey`
CNAMEs -- DMARC is `p=reject`; drift here bounces real mail.

Housekeeping after a successful first apply: delete (or comment out) the two
ingress-rule `import` blocks in `deploy/terraform/network.tf` (see the comment
at the top of that file). They are one-shot and will break the plan at Stage 5
otherwise. Also re-comment (or delete) the `cloudflare_zone.tdfurn` import
block in `deploy/terraform/cloudflare.tf` -- same one-shot deal; once the zone
is in state the block has done its job.

### Rollback

`tofu destroy -target=cloudflare_zone.tdfurn` (or delete the zone in the
dashboard) -- nothing references Cloudflare yet, registrar still points at
Route 53. AWS-side observability resources are harmless to keep.

Note: the zone-targeted destroy does NOT remove
`cloudflare_origin_ca_certificate.inbox` or the `/inbox-zero-tls/*` SSM
parameters -- they hang off the CSR, not the zone, so they survive. They are
harmless to keep (an unused cert + two parked SSM parameters). If abandoning
Cloudflare entirely, destroy them too:

```powershell
tofu destroy -target=cloudflare_origin_ca_certificate.inbox -target=aws_ssm_parameter.origin_cert -target=aws_ssm_parameter.origin_key
```

---

## Stage 2 -- CloudWatch agent on the box (no traffic impact)

Install the agent (arm64 Ubuntu) and point it at the SSM-hosted config:

```powershell
aws ssm send-command --region us-east-1 --instance-ids i-0ddd8a31e870a696e `
  --document-name AWS-RunShellScript --comment "install cloudwatch agent" `
  --parameters 'commands=["wget -q https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb -O /tmp/amazon-cloudwatch-agent.deb","sudo dpkg -i /tmp/amazon-cloudwatch-agent.deb","sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -c ssm:/inbox-zero-config/cloudwatch-agent -s","sleep 5","sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl -a status"]'
```

Poll the invocation with `aws ssm get-command-invocation` -- the final status
output should show `"status": "running"`.

### Verify

Log events arriving in both groups (access needs a request first -- just load
https://inbox.tdfurn.com):

```powershell
aws logs filter-log-events --region us-east-1 --log-group-name /inbox-zero/nginx/access --limit 5 --query "events[].message"
aws logs filter-log-events --region us-east-1 --log-group-name /inbox-zero/nginx/error --limit 5 --query "events[].message"
```

Test alarm -> email delivery (requires the SNS confirmation click from
Stage 0 step 7):

```powershell
aws cloudwatch set-alarm-state --region us-east-1 --alarm-name inbox-zero-nginx-5xx-burst --state-value ALARM --state-reason test
```

An "ALARM: inbox-zero-nginx-5xx-burst" email should arrive within a minute,
followed shortly by an OK email as real (non-breaching) data flows in.

### Rollback

`sudo amazon-cloudwatch-agent-ctl -a stop` via SSM. Log groups/alarms can stay.

---

## Stage 3 -- DNS cutover

In `terraform.tfvars` set `dns_cutover = true`, then:

```powershell
cd deploy/terraform
tofu plan -out plan.out   # exactly one change: aws_route53domains_registered_domain.tdfurn[0]
tofu apply plan.out
```

This repoints the registrar's nameservers at Cloudflare. Registrar NS changes
propagate over minutes-to-hours (the old Route 53 zone keeps answering for
resolvers with cached NS, and it still holds identical data, so there is no
wrong-answer window).

### Verify

1. NS propagation:

   ```powershell
   Resolve-DnsName tdfurn.com -Type NS -Server 1.1.1.1
   Resolve-DnsName tdfurn.com -Type NS -Server 8.8.8.8
   aws route53domains get-domain-detail --region us-east-1 --domain-name tdfurn.com --query "Nameservers"
   ```

   Expect the two `*.ns.cloudflare.com` hosts.

2. `inbox.tdfurn.com` now resolves to Cloudflare IPs (104.x/172.x ranges):

   ```powershell
   Resolve-DnsName inbox.tdfurn.com -Type A -Server 8.8.8.8
   ```

3. Site loads: https://inbox.tdfurn.com (login, dashboard).

4. Gmail webhook still returns 200 **from Cloudflare IPs**. Send yourself a
   test email, then check the access log via CloudWatch:

   ```powershell
   aws logs filter-log-events --region us-east-1 --log-group-name /inbox-zero/nginx/access `
     --filter-pattern '"api/google/webhook"' --limit 10 --query "events[].message"
   ```

   Expect `POST /api/google/webhook ... 200` lines. (Pre-Stage-4 the source
   IPs in the log are Cloudflare edge IPs only if the new nginx config is
   already live; with the old config that is also fine -- what matters is
   the 200.)

5. Email auth spot check: open a recent digest email in Gmail -> "Show
   original" -> Authentication-Results must show `spf=pass`, `dkim=pass`,
   `dmarc=pass`. (Or `swaks --to rebekah@trueocean.com --server aspmx.l.google.com` from a box with port 25 if you want an active probe.)

6. Other properties: https://tdfurn.com and https://www.tdfurn.com (Shopify),
   https://claims.tdfurn.com and https://qb.tdfurn.com (CloudFront) all load.

### Rollback

Set `dns_cutover = false`, `tofu apply` (removes the resource from state
only -- it does NOT touch the registrar), then restore the original Route 53
nameservers:

```powershell
aws route53domains update-domain-nameservers --region us-east-1 --domain-name tdfurn.com `
  --nameservers Name=ns-701.awsdns-23.net Name=ns-353.awsdns-44.com Name=ns-1842.awsdns-38.co.uk Name=ns-1373.awsdns-43.org
```

The Route 53 hosted zone is untouched until Stage 6, so rollback is purely a
registrar pointer flip.

---

## Stage 4 -- Origin CA cert on nginx

Follow `deploy/nginx/README.md`: install cert + key from SSM
`/inbox-zero-tls/*` to `/etc/ssl/cloudflare/`, push `deploy/nginx/inbox.conf`
to `/etc/nginx/sites-available/inbox`, `nginx -t`, reload.

### Verify

- https://inbox.tdfurn.com loads with **no 526 errors** -- SSL mode is already
  Full (strict) from Stage 1, so a 526 here means the origin cert is wrong.
- Cloudflare dashboard -> SSL/TLS shows Full (strict) and the site stays green.
- Access log lines now show real client IPs (CF-Connecting-IP restored), and
  any `token=` query values are logged as `token=REDACTED`.

### Rollback

Per `deploy/nginx/README.md`: restore `inbox.bak` (or swap the commented
Let's Encrypt `ssl_certificate` lines back in) and reload.

---

## Stage 5 -- Origin lockdown

Pre-flight: confirm the two ingress `import` blocks in
`deploy/terraform/network.tf` were removed after Stage 1 (the plan fails with
"configuration for import target does not exist" if not).

Set `lock_origin_to_cloudflare = true`, then:

```powershell
cd deploy/terraform
tofu plan -out plan.out   # destroys the two 0.0.0.0/0 ingress rules,
                          # creates two 443-from-Cloudflare-prefix-list rules
tofu apply plan.out
```

Port 80 is intentionally gone after this: Cloudflare connects to the origin
on 443 (Full strict + Origin CA), and ACME HTTP-01 is no longer needed.

### REQUIRED post-step -- disable the certbot timer

With port 80 closed, every certbot HTTP-01 renewal attempt fails and generates
recurring error noise (failed systemd runs, certbot error logs). The Origin CA
cert is valid ~15 years, so certbot has nothing left to renew. Disable it now:

```powershell
aws ssm send-command --region us-east-1 --instance-ids i-0ddd8a31e870a696e `
  --document-name AWS-RunShellScript --comment "disable certbot timer" `
  --parameters 'commands=["sudo systemctl disable --now certbot.timer"]'
```

### Verify

```powershell
# Direct origin: must time out / be refused now
curl.exe -m 10 -sk https://13.223.138.202/ ; $LASTEXITCODE   # expect 28 (timeout) or 7 (refused)
curl.exe -m 10 -s  http://13.223.138.202/  ; $LASTEXITCODE   # same

# Through Cloudflare: still fine
curl.exe -s -o NUL -w "%{http_code}" https://inbox.tdfurn.com/   # 200 (or 307 to login)
```

Send a test email and confirm webhook 200s keep appearing in
`/inbox-zero/nginx/access` (same filter-log-events command as Stage 3).

### Rollback

Set `lock_origin_to_cloudflare = false` and apply -- recreates the 80/443
open-to-world rules (new sgr- IDs, same effect). If rolling back to Let's
Encrypt TLS, also re-enable the certbot timer (same SSM send-command pattern
as above, with `sudo systemctl enable --now certbot.timer`) -- consistent
with the rollback steps in `deploy/nginx/README.md`.

---

## Stage 6 -- Cleanup (manual, ~1 week after Stage 3)

Once Cloudflare has been answering cleanly for a week:

1. Delete the Route 53 hosted zone Z19CXOEZPIWEYP (saves $0.50/mo; the domain
   REGISTRATION stays at Route 53 Domains). The console is easiest (it deletes
   the records for you); CLI requires emptying the zone of all non-NS/SOA
   records first, then:

   ```powershell
   aws route53 delete-hosted-zone --id Z19CXOEZPIWEYP
   ```

(The certbot timer was already disabled as a required Stage 5 post-step --
nothing else to clean up on the box.)

Note: after the hosted zone is deleted, the Stage 3 rollback path no longer
has a Route 53 zone to fall back to -- rebuilding it from
`deploy/terraform/cloudflare.tf` record values would be required. That is why
this stage waits a week.

---

## Tripwire -- Cloudflare IP range drift

The AWS prefix lists (`cloudflare-ipv4`/`cloudflare-ipv6`) and the
`set_real_ip_from` list in `deploy/nginx/inbox.conf` are point-in-time copies
of Cloudflare's published ranges (https://www.cloudflare.com/ips/). They
refresh only when humans act. Cloudflare changes these rarely (years), but:

- Re-run `tofu plan` quarterly, or whenever Cloudflare announces IP range
  changes. The plan will show prefix-list entry drift if the published list
  moved.
- If the prefix lists change, update the hardcoded list in
  `deploy/nginx/inbox.conf` at the same time.

Symptom of missing a change: new Cloudflare edge IPs get dropped by the SG ->
intermittent 522 (connection timed out) errors through Cloudflare.

## Cost summary

| Item | Monthly |
|------|---------|
| Cloudflare free plan (DNS, proxy, WAF custom rules, Origin CA) | $0.00 |
| CloudWatch Logs ingestion (~0.4 GB/mo worst case, within 5 GB free tier) | ~$0.00 |
| CloudWatch log storage (60-day retention, negligible volume) | ~$0.00 |
| 2 new standard alarms (nginx-5xx-burst, webhook-failures) @ $0.10 | $0.20 |
| Log anomaly detectors (priced into ingestion) | $0.00 |
| Route 53 hosted zone, removed at Stage 6 | -$0.50 |
| **Net** | **~ -$0.30** |
