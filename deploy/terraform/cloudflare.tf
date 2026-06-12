# Cloudflare zone for tdfurn.com, mirroring the Route 53 hosted zone
# Z19CXOEZPIWEYP record-for-record (values pulled from
# `aws route53 list-resource-record-sets` on 2026-06-12).
#
# Everything is DNS-only (proxied = false) except inbox.tdfurn.com, which is
# the one record that goes through the Cloudflare proxy (orange cloud).
#
# Provider v5 notes:
# - the resource is cloudflare_dns_record (cloudflare_record is the old v4 name)
# - zone settings are per-setting cloudflare_zone_setting resources
#   (zone_settings_override is v4-only)
# - TXT content is stored quoted by the Cloudflare API; we write it with
#   escaped quotes to avoid a perpetual plan diff
# - hostnames in record content are written lowercase because the Cloudflare
#   API normalizes them to lowercase (DNS is case-insensitive; Route 53 showed
#   ASPMX.L.GOOGLE.COM etc. in uppercase)

resource "cloudflare_zone" "tdfurn" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "tdfurn.com"
  type = "full"
  # Free plan: new zones default to the free plan; the v5 zone resource has no
  # plan argument. If `tofu validate` ever complains about the account block
  # shape after a provider upgrade, check the cloudflare_zone docs -- v5 takes
  # account = { id = ... }.
}

# ---------------------------------------------------------------------------
# Apex (tdfurn.com) -- Shopify A record, Google Workspace MX, SPF + site
# verification TXT.
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "apex_a" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "tdfurn.com"
  type    = "A"
  content = "23.227.38.65" # Shopify apex -- must stay DNS-only
  ttl     = 300
  proxied = false
}

locals {
  # Google Workspace MX set, exactly as in Route 53 (priority => host).
  google_mx = {
    "1"   = "aspmx.l.google.com"
    "5a"  = "alt1.aspmx.l.google.com"
    "5b"  = "alt2.aspmx.l.google.com"
    "10a" = "alt3.aspmx.l.google.com"
    "10b" = "alt4.aspmx.l.google.com"
  }
  google_mx_priority = {
    "1"   = 1
    "5a"  = 5
    "5b"  = 5
    "10a" = 10
    "10b" = 10
  }
}

resource "cloudflare_dns_record" "apex_mx" {
  for_each = local.google_mx

  zone_id  = cloudflare_zone.tdfurn.id
  name     = "tdfurn.com"
  type     = "MX"
  content  = each.value
  priority = local.google_mx_priority[each.key]
  ttl      = 300
  proxied  = false
}

# Route 53 held both TXT values in a single record set; Cloudflare wants one
# record per value (same name).
resource "cloudflare_dns_record" "apex_spf" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "tdfurn.com"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 300
  proxied = false
}

resource "cloudflare_dns_record" "apex_google_site_verification" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "tdfurn.com"
  type    = "TXT"
  content = "\"google-site-verification=UY7HR5xro1C1oI6vlCVYMiL-YZ5Jo66ZVyoea9pJht8\""
  ttl     = 300
  proxied = false
}

# ---------------------------------------------------------------------------
# Email authentication -- DMARC is p=reject; any drift here bounces real mail.
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "dmarc" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "_dmarc.tdfurn.com"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject; rua=mailto:re+xmqxganirqm@dmarc.postmarkapp.com; fo=1\""
  ttl     = 3600
  proxied = false
}

# SES DKIM (3 CNAMEs).
locals {
  ses_dkim_tokens = [
    "4m7azekszg5fxambtddoppt4ifyjiwhu",
    "524mkcl56qosviyizi7yqwrsl237ipqq",
    "ncgqxncrpk2gdwrgdbwr5hxkqmibvaev",
  ]
}

resource "cloudflare_dns_record" "ses_dkim" {
  for_each = toset(local.ses_dkim_tokens)

  zone_id = cloudflare_zone.tdfurn.id
  name    = "${each.value}._domainkey.tdfurn.com"
  type    = "CNAME"
  content = "${each.value}.dkim.amazonses.com"
  ttl     = 1800
  proxied = false
}

# Resend DKIM.
resource "cloudflare_dns_record" "resend_dkim" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "resend._domainkey.tdfurn.com"
  type    = "TXT"
  content = "\"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC65DZlSoJSF9LBTxlllHQeFxr7ZVWib6IwY9X8eK3/KXq/tjctJy0odrvkVYGlJ60aS7JL+KUqKWF5bNSkPPW8yPrGGBLnLaUKcYBd8lSdhFlTfA05TPFCx6AJMeeIsuo1+042WXA5+YNbZsBhoL3fuslLbbHFHekLUUlsESPiuQIDAQAB\""
  ttl     = 300
  proxied = false
}

# SES MAIL FROM domains (mail. and send.).
resource "cloudflare_dns_record" "mail_mx" {
  zone_id  = cloudflare_zone.tdfurn.id
  name     = "mail.tdfurn.com"
  type     = "MX"
  content  = "feedback-smtp.us-east-1.amazonses.com"
  priority = 10
  ttl      = 3600
  proxied  = false
}

resource "cloudflare_dns_record" "mail_spf" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "mail.tdfurn.com"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 3600
  proxied = false
}

resource "cloudflare_dns_record" "send_mx" {
  zone_id  = cloudflare_zone.tdfurn.id
  name     = "send.tdfurn.com"
  type     = "MX"
  content  = "feedback-smtp.us-east-1.amazonses.com"
  priority = 10
  ttl      = 300
  proxied  = false
}

resource "cloudflare_dns_record" "send_spf" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "send.tdfurn.com"
  type    = "TXT"
  content = "\"v=spf1 include:amazonses.com ~all\""
  ttl     = 300
  proxied = false
}

# ---------------------------------------------------------------------------
# CloudFront-backed subdomains. Route 53 used A+AAAA aliases; Cloudflare has
# no alias concept, so each becomes a single DNS-only CNAME (CloudFront
# answers both A and AAAA for the CNAME target).
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "claims" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "claims.tdfurn.com"
  type    = "CNAME"
  content = "d21tnnftb93lua.cloudfront.net"
  ttl     = 300
  proxied = false
}

# ACM validation record for claims -- must persist or the CloudFront cert
# stops renewing.
resource "cloudflare_dns_record" "claims_acm_validation" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "_d661607dc3544f56cb6342c3722e05b9.claims.tdfurn.com"
  type    = "CNAME"
  content = "_5f85bf934bf2cc3c89b9ec609a9a8603.jkddzztszm.acm-validations.aws"
  ttl     = 60
  proxied = false
}

resource "cloudflare_dns_record" "qb" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "qb.tdfurn.com"
  type    = "CNAME"
  content = "dmvzzuepui4k5.cloudfront.net"
  ttl     = 300
  proxied = false
}

resource "cloudflare_dns_record" "qb_acm_validation" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "_111e5d8d6de19aa8940fc9c7e46676ca.qb.tdfurn.com"
  type    = "CNAME"
  content = "_8ebc08d3ecf6e179abab411a3dd36b89.jkddzztszm.acm-validations.aws"
  ttl     = 300
  proxied = false
}

# ---------------------------------------------------------------------------
# inbox.tdfurn.com -- THE ONLY PROXIED RECORD. Cloudflare requires ttl = 1
# ("automatic") on proxied records.
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "inbox" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "inbox.tdfurn.com"
  type    = "A"
  content = "13.223.138.202"
  ttl     = 1 # automatic -- mandatory when proxied
  proxied = true
}

# Shopify storefront www.
resource "cloudflare_dns_record" "www" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "www.tdfurn.com"
  type    = "CNAME"
  content = "shops.myshopify.com"
  ttl     = 300
  proxied = false
}

# ---------------------------------------------------------------------------
# Zone settings: Full (strict) origin TLS, force HTTPS, TLS 1.2 floor.
# ---------------------------------------------------------------------------

resource "cloudflare_zone_setting" "ssl" {
  zone_id    = cloudflare_zone.tdfurn.id
  setting_id = "ssl"
  value      = "strict"
}

resource "cloudflare_zone_setting" "always_use_https" {
  zone_id    = cloudflare_zone.tdfurn.id
  setting_id = "always_use_https"
  value      = "on"
}

resource "cloudflare_zone_setting" "min_tls_version" {
  zone_id    = cloudflare_zone.tdfurn.id
  setting_id = "min_tls_version"
  value      = "1.2"
}

# ---------------------------------------------------------------------------
# WAF custom rule: never challenge/block/rate-limit Google's Pub/Sub webhook
# deliveries. Google posts from GCP IPs with a non-browser user agent -- exactly
# the traffic shape security products love to eat.
#
# NOTE: Bot Fight Mode CANNOT be skipped by this (or any) rule on the free
# plan -- it must remain OFF in the dashboard (it is off by default). If the
# webhook ever starts getting 403s from Cloudflare, check that first.
# ---------------------------------------------------------------------------

resource "cloudflare_ruleset" "webhook_skip" {
  zone_id = cloudflare_zone.tdfurn.id
  name    = "inbox-zero webhook allowlist"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules = [
    {
      action      = "skip"
      expression  = "(starts_with(http.request.uri.path, \"/api/google/webhook\"))"
      description = "Skip security products for the Gmail Pub/Sub webhook path"
      enabled     = true
      action_parameters = {
        phases = [
          "http_ratelimit",
          "http_request_sbfm",
          "http_request_firewall_managed",
        ]
        products = [
          "securityLevel",
          "uaBlock",
          "bic",
          "hot",
          "zoneLockdown",
        ]
      }
      logging = {
        enabled = true
      }
    }
  ]
}

# ---------------------------------------------------------------------------
# Origin CA certificate for nginx. Cloudflare-signed, trusted only by
# Cloudflare's edge -- perfect for a proxied-only origin, no certbot renewals
# for ~15 years.
#
# TRADEOFF (documented in deploy/CLOUDFLARE-CUTOVER.md): the private key is
# generated by the tls provider and therefore lives in the Terraform state
# file (S3, server-side encrypted). Accepted for this single-user stack; the
# key is only useful to someone who can also reach the origin, which post-
# lockdown means Cloudflare edge IPs only.
# ---------------------------------------------------------------------------

resource "tls_private_key" "origin" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem

  subject {
    common_name  = "inbox.tdfurn.com"
    organization = "inbox-zero"
  }
}

# Requires the Origin CA Key (CLOUDFLARE_API_USER_SERVICE_KEY) -- see
# versions.tf provider comment and CLOUDFLARE-CUTOVER.md Stage 0.
resource "cloudflare_origin_ca_certificate" "inbox" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = ["inbox.tdfurn.com"]
  request_type       = "origin-ecc"
  requested_validity = 5475 # 15 years (max)
}

# Cert + key parked in SSM for the box to fetch via its instance role.
# Path prefix is /inbox-zero-tls/ (NOT /inbox-zero/) on purpose:
# deploy/load-secrets.sh does `get-parameters-by-path --path /inbox-zero/
# --recursive` into /opt/inbox-zero/.env, and a multi-line PEM would corrupt
# that file. /inbox-zero-tls/ is outside that subtree, so it can never be
# swept into .env.
resource "aws_ssm_parameter" "origin_cert" {
  name        = "/inbox-zero-tls/origin-cert"
  description = "Cloudflare Origin CA certificate (PEM) for inbox.tdfurn.com. Installed to /etc/ssl/cloudflare/ on the box -- see deploy/nginx/README.md."
  type        = "String"
  tier        = "Standard"
  value       = cloudflare_origin_ca_certificate.inbox.certificate
}

resource "aws_ssm_parameter" "origin_key" {
  name        = "/inbox-zero-tls/origin-key"
  description = "Private key (PEM) for the Cloudflare Origin CA certificate. Installed to /etc/ssl/cloudflare/ on the box -- see deploy/nginx/README.md."
  type        = "SecureString"
  tier        = "Standard"
  value       = tls_private_key.origin.private_key_pem
}
