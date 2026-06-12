# Registrar nameserver delegation for tdfurn.com.
#
# =========================== THE CUTOVER SWITCH ============================
# Setting dns_cutover = true and applying repoints the domain's registrar
# (Route 53 Domains) nameservers at the Cloudflare zone's nameservers. From
# that moment resolvers progressively stop asking Route 53 and start asking
# Cloudflare. Do this ONLY at CLOUDFLARE-CUTOVER.md Stage 3, after Stage 1
# verification confirmed the Cloudflare zone answers identically.
#
# ROLLBACK: set dns_cutover = false and apply (this only removes the resource
# from state -- it does NOT touch the registrar), then manually restore the
# four Route 53 hosted-zone nameservers:
#
#   aws route53domains update-domain-nameservers \
#     --region us-east-1 \
#     --domain-name tdfurn.com \
#     --nameservers Name=ns-701.awsdns-23.net Name=ns-353.awsdns-44.com \
#                   Name=ns-1842.awsdns-38.co.uk Name=ns-1373.awsdns-43.org
#
# (Original awsdns set, recorded 2026-06-12: ns-701.awsdns-23.net,
# ns-353.awsdns-44.com, ns-1842.awsdns-38.co.uk, ns-1373.awsdns-43.org.)
# ===========================================================================
#
# Notes:
# - Route 53 Domains is a us-east-1-only API; the default provider already
#   targets us-east-1.
# - This resource "adopts" the existing registration (it is never created or
#   destroyed at the registrar); destroy only forgets it from state.
# - transfer_lock stays true -- the domain registration itself is NOT moving,
#   only DNS hosting.

resource "aws_route53domains_registered_domain" "tdfurn" {
  count = var.dns_cutover ? 1 : 0

  domain_name   = "tdfurn.com"
  transfer_lock = true

  dynamic "name_server" {
    for_each = cloudflare_zone.tdfurn.name_servers
    content {
      name = name_server.value
    }
  }
}
