# Observability: nginx logs to CloudWatch, metric filters + alarms, SNS
# email alerts, log anomaly detection, and codification of the two existing
# click-ops EC2 status-check alarms.

locals {
  # Shared cross-project SNS topic the existing EC2 status alarms point at.
  # Deliberately NOT managed by this stack -- referenced as a string only.
  cloudwatch_error_topic_arn = "arn:aws:sns:${var.aws_region}:${data.aws_caller_identity.current.account_id}:CloudwatchError"
}

# ---------------------------------------------------------------------------
# Log groups for nginx access/error logs shipped by the CloudWatch agent.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "nginx_access" {
  name              = "/inbox-zero/nginx/access"
  retention_in_days = 60
}

resource "aws_cloudwatch_log_group" "nginx_error" {
  name              = "/inbox-zero/nginx/error"
  retention_in_days = 60
}

# The instance role's existing inline logs policy is scoped only to
# /aws/ssm/inbox-zero-sessions, so the CloudWatch agent needs its own grant
# for the nginx log groups. Same pattern as ec2_ssm_core in main.tf: we
# attach to the pre-existing role by name.
data "aws_iam_policy_document" "nginx_logs" {
  statement {
    sid    = "WriteNginxLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = [
      "arn:aws:logs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:log-group:/inbox-zero/nginx/*:*",
    ]
  }

  statement {
    sid       = "DescribeLogGroups"
    effect    = "Allow"
    actions   = ["logs:DescribeLogGroups"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "nginx_logs" {
  name   = "inbox-zero-nginx-logs"
  role   = var.ec2_instance_role
  policy = data.aws_iam_policy_document.nginx_logs.json
}

# ---------------------------------------------------------------------------
# CloudWatch agent configuration, served to the box via SSM
# (`amazon-cloudwatch-agent-ctl ... -c ssm:/inbox-zero-config/cloudwatch-agent`).
#
# Path prefix is /inbox-zero-config/ (NOT /inbox-zero/) on purpose:
# deploy/load-secrets.sh sweeps `get-parameters-by-path --path /inbox-zero/
# --recursive` into /opt/inbox-zero/.env, and this JSON blob must never land
# in the app's env file.
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "cloudwatch_agent_config" {
  name        = "/inbox-zero-config/cloudwatch-agent"
  description = "CloudWatch agent config: ship nginx access/error logs to /inbox-zero/nginx/*. Outside /inbox-zero/ so load-secrets.sh never sweeps it into .env."
  type        = "String"
  tier        = "Standard"

  value = jsonencode({
    logs = {
      logs_collected = {
        files = {
          collect_list = [
            {
              file_path        = "/var/log/nginx/access.log"
              log_group_name   = "/inbox-zero/nginx/access"
              log_stream_name  = "{instance_id}"
              timestamp_format = "%d/%b/%Y:%H:%M:%S %z"
              timezone         = "UTC"
            },
            {
              file_path       = "/var/log/nginx/error.log"
              log_group_name  = "/inbox-zero/nginx/error"
              log_stream_name = "{instance_id}"
            },
          ]
        }
      }
    }
  })
}

# ---------------------------------------------------------------------------
# Alerting topic. Email subscription must be CONFIRMED by clicking the link
# AWS sends to var.alert_email after the first apply -- until then alarms fire
# into the void.
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "inbox_zero_alerts" {
  name = "inbox-zero-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.inbox_zero_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ---------------------------------------------------------------------------
# Metric filters over the access log. nginx logs in `combined` format
# (space-delimited, 9 fields once bracketed/quoted fields collapse):
#   $remote_addr - $remote_user [$time_local] "$request" $status
#   $body_bytes_sent "$http_referer" "$http_user_agent"
# deploy/nginx/inbox.conf keeps this exact field structure (the redacted
# format only rewrites the $request payload), so these patterns hold.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_metric_filter" "nginx_5xx" {
  name           = "nginx-5xx"
  log_group_name = aws_cloudwatch_log_group.nginx_access.name
  pattern        = "[ip, id, user, timestamp, request, status_code=5*, bytes, referrer, agent]"

  metric_transformation {
    name          = "Nginx5xxCount"
    namespace     = "InboxZero"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_log_metric_filter" "webhook_non2xx" {
  name           = "webhook-non2xx"
  log_group_name = aws_cloudwatch_log_group.nginx_access.name
  pattern        = "[ip, id, user, timestamp, request=\"*api/google/webhook*\", status_code!=2*, bytes, referrer, agent]"

  metric_transformation {
    name          = "WebhookNon2xxCount"
    namespace     = "InboxZero"
    value         = "1"
    default_value = "0"
  }
}

# ---------------------------------------------------------------------------
# Paging alarms (alarm + ok -> inbox-zero-alerts).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "nginx_5xx_burst" {
  alarm_name          = "inbox-zero-nginx-5xx-burst"
  alarm_description   = "10+ nginx 5xx responses within 5 minutes on inbox.tdfurn.com."
  namespace           = "InboxZero"
  metric_name         = "Nginx5xxCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.inbox_zero_alerts.arn]
  ok_actions    = [aws_sns_topic.inbox_zero_alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "webhook_failures" {
  alarm_name          = "inbox-zero-webhook-failures"
  alarm_description   = "3+ non-2xx responses on /api/google/webhook within 15 minutes -- Gmail Pub/Sub deliveries are failing."
  namespace           = "InboxZero"
  metric_name         = "WebhookNon2xxCount"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.inbox_zero_alerts.arn]
  ok_actions    = [aws_sns_topic.inbox_zero_alerts.arn]
}

# ---------------------------------------------------------------------------
# Log anomaly detection. Free (priced into ingestion); findings surface in
# the CloudWatch console but do NOT page -- the metric alarms above are the
# paging path. log_group_arn_list takes exactly one ARN per detector.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_anomaly_detector" "nginx_access" {
  detector_name        = "inbox-zero-nginx-access"
  log_group_arn_list   = [aws_cloudwatch_log_group.nginx_access.arn]
  evaluation_frequency = "FIVE_MIN"
  enabled              = true
}

resource "aws_cloudwatch_log_anomaly_detector" "nginx_error" {
  detector_name        = "inbox-zero-nginx-error"
  log_group_arn_list   = [aws_cloudwatch_log_group.nginx_error.arn]
  evaluation_frequency = "FIVE_MIN"
  enabled              = true
}

# ---------------------------------------------------------------------------
# Existing click-ops EC2 status-check alarms, codified. Config below
# replicates `aws cloudwatch describe-alarms` output exactly (2026-06-12).
# Actions keep pointing at the shared CloudwatchError topic, which this
# stack does NOT manage. Import blocks are idempotent no-ops once adopted.
# ---------------------------------------------------------------------------

import {
  to = aws_cloudwatch_metric_alarm.instance_status_check
  id = "inbox-zero-instance-status-check"
}

import {
  to = aws_cloudwatch_metric_alarm.system_status_check
  id = "inbox-zero-system-status-check"
}

resource "aws_cloudwatch_metric_alarm" "instance_status_check" {
  alarm_name          = "inbox-zero-instance-status-check"
  alarm_description   = "EC2 instance status check failed for inbox-zero"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_Instance"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    InstanceId = var.ec2_instance_id
  }

  alarm_actions = [local.cloudwatch_error_topic_arn]
  ok_actions    = [local.cloudwatch_error_topic_arn]
}

resource "aws_cloudwatch_metric_alarm" "system_status_check" {
  alarm_name          = "inbox-zero-system-status-check"
  alarm_description   = "EC2 system status check failed for inbox-zero (AWS hardware issue)"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed_System"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    InstanceId = var.ec2_instance_id
  }

  alarm_actions = [local.cloudwatch_error_topic_arn]
  ok_actions    = [local.cloudwatch_error_topic_arn]
}
