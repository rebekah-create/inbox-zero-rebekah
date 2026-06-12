# Security group codification + Cloudflare origin lockdown.
#
# The security group sg-06a2ef1d003019fba ("inbox-zero-sg") and its three
# rules were created by hand. The import blocks below adopt them into state
# on the first apply (sgr- IDs from `aws ec2 describe-security-group-rules`,
# 2026-06-12).
#
# IMPORTANT -- one-shot import blocks: after the first successful apply,
# delete (or comment out) the two ingress-rule import blocks. They target
# http_open[0] / https_open[0], which stop existing once
# lock_origin_to_cloudflare = true flips their count to 0, and a dangling
# import block pointing at a nonexistent address fails the plan.
# (CLOUDFLARE-CUTOVER.md Stage 5 includes this step.)

import {
  to = aws_security_group.inbox_zero
  id = "sg-06a2ef1d003019fba"
}

import {
  to = aws_vpc_security_group_ingress_rule.http_open[0]
  id = "sgr-01e4ebccb4b16963d"
}

import {
  to = aws_vpc_security_group_ingress_rule.https_open[0]
  id = "sgr-0a7b0b94c10d38922"
}

import {
  to = aws_vpc_security_group_egress_rule.all
  id = "sgr-0c8b46376bc2aec15"
}

# Rules are managed exclusively via aws_vpc_security_group_*_rule resources;
# the group itself carries no inline rules (inline ingress/egress are
# Optional+Computed in provider v5, so omitting them here leaves the imported
# rules untouched).
resource "aws_security_group" "inbox_zero" {
  name        = "inbox-zero-sg"
  description = "Inbox Zero server" # must match the existing group exactly -- changing it forces replacement
  vpc_id      = var.vpc_id

  tags = {
    Name = "inbox-zero-sg"
  }

  lifecycle {
    prevent_destroy = true
  }
}

# ---------------------------------------------------------------------------
# Pre-lockdown rules (the current click-ops state): 80 + 443 open to the
# world. Removed when lock_origin_to_cloudflare = true.
# ---------------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "http_open" {
  count = var.lock_origin_to_cloudflare ? 0 : 1

  security_group_id = aws_security_group.inbox_zero.id
  description       = "HTTP"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "https_open" {
  count = var.lock_origin_to_cloudflare ? 0 : 1

  security_group_id = aws_security_group.inbox_zero.id
  description       = "HTTPS"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

# Egress stays wide open in both modes (imported, unchanged).
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.inbox_zero.id
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# ---------------------------------------------------------------------------
# Cloudflare edge IP ranges as managed prefix lists.
#
# NOTE: prefix-list entries refresh only on `tofu apply` -- they are a
# point-in-time copy of data.cloudflare_ip_ranges. Cloudflare's published
# ranges change rarely (on the order of years), and the cutover runbook
# includes a quarterly `tofu plan` tripwire that will surface any drift.
# ---------------------------------------------------------------------------

data "cloudflare_ip_ranges" "cloudflare" {}

resource "aws_ec2_managed_prefix_list" "cloudflare_ipv4" {
  name           = "cloudflare-ipv4"
  address_family = "IPv4"
  max_entries    = 20 # currently 15 published ranges; headroom for additions

  dynamic "entry" {
    for_each = data.cloudflare_ip_ranges.cloudflare.ipv4_cidrs
    content {
      cidr        = entry.value
      description = "Cloudflare edge IPv4"
    }
  }

  tags = {
    Name = "cloudflare-ipv4"
  }
}

resource "aws_ec2_managed_prefix_list" "cloudflare_ipv6" {
  name           = "cloudflare-ipv6"
  address_family = "IPv6"
  max_entries    = 10 # currently 7 published ranges

  dynamic "entry" {
    for_each = data.cloudflare_ip_ranges.cloudflare.ipv6_cidrs
    content {
      cidr        = entry.value
      description = "Cloudflare edge IPv6"
    }
  }

  tags = {
    Name = "cloudflare-ipv6"
  }
}

# ---------------------------------------------------------------------------
# Post-lockdown rules: 443 only, Cloudflare edge ranges only.
#
# Port 80 is intentionally dropped after lockdown -- Cloudflare connects to
# the origin on 443 (Full strict + Origin CA cert), and ACME HTTP-01 is no
# longer needed once the Origin CA certificate replaces Let's Encrypt on
# nginx. The :80 redirect server block stays in nginx config purely for
# rollback convenience.
# ---------------------------------------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "https_cloudflare_v4" {
  count = var.lock_origin_to_cloudflare ? 1 : 0

  security_group_id = aws_security_group.inbox_zero.id
  description       = "HTTPS from Cloudflare edge (IPv4)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_ec2_managed_prefix_list.cloudflare_ipv4.id
}

resource "aws_vpc_security_group_ingress_rule" "https_cloudflare_v6" {
  count = var.lock_origin_to_cloudflare ? 1 : 0

  security_group_id = aws_security_group.inbox_zero.id
  description       = "HTTPS from Cloudflare edge (IPv6)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = aws_ec2_managed_prefix_list.cloudflare_ipv6.id
}
