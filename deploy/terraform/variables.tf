variable "aws_region" {
  description = "AWS region the EC2 host lives in."
  type        = string
  default     = "us-east-1"
}

variable "github_repo" {
  description = "GitHub repository in 'owner/name' form. Trust policy is scoped to pushes on main of this repo only."
  type        = string
}

variable "github_branch" {
  description = "Branch ref the OIDC trust policy allows. Defaults to main; set to '*' only if you understand the blast radius."
  type        = string
  default     = "main"
}

variable "ec2_instance_id" {
  description = "EC2 instance ID the deploy role is allowed to send SSM commands to."
  type        = string
}

variable "ec2_instance_role" {
  description = "Name of the existing IAM role attached to the EC2 instance profile (for attaching AmazonSSMManagedInstanceCore)."
  type        = string
}

variable "create_oidc_provider" {
  description = "Whether to create the IAM OIDC provider for GitHub Actions. Set false if it already exists in this AWS account."
  type        = bool
  default     = true
}

variable "role_name" {
  description = "Name of the IAM role GitHub Actions assumes via OIDC."
  type        = string
  default     = "inbox-zero-gha-deploy"
}

variable "openrouter_api_key" {
  description = "OpenRouter API key. Stored as SSM SecureString at /inbox-zero/OPENROUTER_API_KEY. Leave blank in tfvars and tofu will prompt at apply time."
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID (dashboard -> any zone -> Overview, right column, or Manage Account). Not a secret, but personal -- committed tfvars carries a placeholder."
  type        = string
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token (scopes: Zone:Edit, DNS:Edit, Zone Settings:Edit, Zone WAF:Edit, SSL and Certificates:Edit -- the last one covers Origin CA cert issuance). Prefer the CLOUDFLARE_API_TOKEN environment variable over setting this; leave at the empty-string default to use the env var."
  type        = string
  sensitive   = true
  default     = ""
}

variable "vpc_id" {
  description = "VPC the inbox-zero security group lives in."
  type        = string
  default     = "vpc-d2fe1db5"
}

variable "dns_cutover" {
  description = "THE cutover switch. When true, repoints the tdfurn.com registrar nameservers to the Cloudflare zone's nameservers. See deploy/CLOUDFLARE-CUTOVER.md Stage 3 before flipping this."
  type        = bool
  default     = false
}

variable "lock_origin_to_cloudflare" {
  description = "When true, removes the 0.0.0.0/0 ingress on ports 80/443 and allows 443 only from Cloudflare edge IP ranges. Flip only after the Origin CA cert is installed on nginx (CLOUDFLARE-CUTOVER.md Stage 5)."
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Email address subscribed to the inbox-zero-alerts SNS topic. The subscription must be confirmed by clicking the link AWS emails after apply."
  type        = string
  default     = "rebekah@trueocean.com"
}
