#!/bin/bash
set -e

echo "Loading secrets from AWS Parameter Store..."

aws ssm get-parameters-by-path \
  --path "/inbox-zero/" \
  --with-decryption \
  --region us-east-1 \
  --output json \
  | jq -r '.Parameters[] | (.Name | split("/") | last) + "=" + (.Value | @json)' \
  > /opt/inbox-zero/.env

echo "Secrets loaded: $(wc -l < /opt/inbox-zero/.env) variables written to .env"
