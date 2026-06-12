output "gha_deploy_role_arn" {
  description = "Paste this into the GitHub Actions workflow as `role-to-assume` for aws-actions/configure-aws-credentials."
  value       = aws_iam_role.gha_deploy.arn
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC provider (newly created or existing)."
  value       = local.oidc_provider_arn
}

output "cloudflare_name_servers" {
  description = "Nameservers Cloudflare assigned to the tdfurn.com zone. These are what the registrar gets pointed at when dns_cutover = true."
  value       = cloudflare_zone.tdfurn.name_servers
}
