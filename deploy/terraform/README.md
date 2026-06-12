# Terraform / OpenTofu -- GitHub Actions OIDC + SSM Deploy + Cloudflare + Observability

Provisions:

1. The AWS resources needed to retire the long-lived `EC2_SSH_KEY` GitHub
   Actions secret and replace it with short-lived OIDC-issued STS credentials
   (deploys go over SSM `SendCommand`, so port 22 can be closed).
2. The Cloudflare zone for tdfurn.com (DNS mirror of Route 53, proxied
   inbox.tdfurn.com, WAF webhook skip rule, Origin CA cert) plus the EC2
   security-group lockdown to Cloudflare edge IPs.
3. Observability: nginx access/error logs to CloudWatch, metric filters,
   paging alarms via a new SNS topic, log anomaly detectors, and codification
   of the two pre-existing EC2 status-check alarms.

## Providers

| Provider | Version | Auth |
|----------|---------|------|
| hashicorp/aws | ~> 5.0 | ambient AWS credentials |
| cloudflare/cloudflare | ~> 5.0 (v5 resource syntax) | `CLOUDFLARE_API_TOKEN` env var |
| hashicorp/tls | ~> 4.0 | n/a (generates the origin key/CSR) |

The Cloudflare API token must carry: Zone:Edit, DNS:Edit, Zone Settings:Edit,
Zone WAF:Edit, SSL and Certificates:Edit (Origin CA), and account-level
zone-create scope. See `CLOUDFLARE-CUTOVER.md` Stage 0 for click-by-click
token setup. Note: provider v5 cannot combine `api_token` with the legacy
Origin CA service key, so the token's SSL-and-Certificates scope is what
authorizes `cloudflare_origin_ca_certificate`.

## What this creates (original OIDC/SSM portion)

- **IAM OIDC provider** for `token.actions.githubusercontent.com` (one per AWS
  account -- skip with `create_oidc_provider = false` if you already have one).
- **IAM role** `inbox-zero-gha-deploy` with a trust policy restricted to
  pushes on `refs/heads/main` of `rebekah-create/inbox-zero-rebekah`.
- **Inline policy** allowing only `ssm:SendCommand` on the specific EC2 instance
  + the AWS-managed `AWS-RunShellScript` document, plus `ssm:GetCommandInvocation`
  for status polling. Nothing else.
- **IAM instance profile policy attachment** to ensure the EC2 role
  (`inbox-zero-role` per the existing setup) has `AmazonSSMManagedInstanceCore`
  attached. This is what lets SSM RunCommand reach the box.

## File map

| File | Contents |
|------|----------|
| `main.tf` | OIDC provider, deploy role, SSM core attachment, OpenRouter SSM param |
| `cloudflare.tf` | Zone, all DNS records, zone settings, WAF skip rule, Origin CA cert + SSM params |
| `registrar.tf` | `dns_cutover` switch -- registrar NS repoint (Stage 3) |
| `network.tf` | SG + rule imports, Cloudflare prefix lists, `lock_origin_to_cloudflare` switch (Stage 5) |
| `observability.tf` | Log groups, agent config SSM param, SNS topic, metric filters, alarms, anomaly detectors, status-alarm imports |

## Feature flags -- staged apply

Two booleans gate the dangerous steps and default to `false`:

- `dns_cutover` -- repoints the tdfurn.com registrar nameservers to
  Cloudflare. THE cutover switch.
- `lock_origin_to_cloudflare` -- removes 80/443-from-anywhere SG rules and
  allows 443 only from Cloudflare edge prefix lists.

Do NOT flip either ad hoc. Follow the staged runbook in
[`../CLOUDFLARE-CUTOVER.md`](../CLOUDFLARE-CUTOVER.md) -- it sequences apply,
verification, and rollback for every stage (including the one-shot SG import
blocks in `network.tf` that must be removed after the first apply).

## Inputs

Set these in `terraform.tfvars` (gitignored -- never commit it; see
`terraform.tfvars.example`):

```hcl
github_repo           = "rebekah-create/inbox-zero-rebekah"
ec2_instance_id       = "i-0ddd8a31e870a696e"
ec2_instance_role     = "inbox-zero-role"
aws_region            = "us-east-1"
create_oidc_provider  = true   # false if the provider already exists in this account
cloudflare_account_id = "<from the Cloudflare dashboard>"

dns_cutover               = false
lock_origin_to_cloudflare = false
alert_email               = "rebekah@trueocean.com"
```

Secrets come from environment variables, never tfvars:

```powershell
$env:CLOUDFLARE_API_TOKEN = "<token>"   # see CLOUDFLARE-CUTOVER.md Stage 0
```

## Apply

```bash
cd deploy/terraform
tofu init
tofu plan -out plan.out
tofu apply plan.out
```

Outputs include `gha_deploy_role_arn` -- copy that into the GitHub Actions
workflow as `role-to-assume`.

## After apply

1. Confirm SSM agent is running on the box:
   `sudo systemctl status amazon-ssm-agent` -- should be `active (running)`. If
   it's not installed: `sudo snap install amazon-ssm-agent --classic` (Ubuntu)
   or follow the AWS docs.
2. Update `.github/workflows/docker-build.yml` to assume the role and use
   `aws ssm send-command` instead of `appleboy/ssh-action`. Sample diff is in
   `WORKFLOW-MIGRATION.md`.
3. Remove the `EC2_SSH_KEY` secret from the GitHub repo settings.
4. Optionally close port 22 in the EC2 security group -- SSM tunnels through the
   agent's outbound HTTPS connection, no inbound SSH needed.

## Why SSM, not SSH-with-OIDC

There's no native way to have GitHub OIDC mint an SSH key for an EC2 instance.
You can put SSH keys in Secrets Manager and rotate them, but you'd still need
some auth path to fetch them. SSM RunCommand replaces SSH entirely with an
AWS-IAM-authorized control plane -- short-lived STS creds in, command run on the
box, output returned. No long-lived key material.
