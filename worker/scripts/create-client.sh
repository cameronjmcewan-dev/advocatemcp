#!/usr/bin/env bash
# Create a new AdvocateMCP client account via the admin endpoint.
#
# Usage:
#   ./scripts/create-client.sh \
#     --email     "client@example.com" \
#     --password  "SecurePass123!" \
#     --name      "Jane Smith" \
#     --slug      "austin-ace-plumbing" \
#     --biz-name  "Austin Ace Plumbing" \
#     --api-key   "<railway-api-key-for-that-slug>" \
#     --admin-secret "<ADMIN_SECRET value>" \
#     --url       "https://advocatecameron.workers.dev"

set -euo pipefail

# PRODUCTION_URL is the live workers.dev URL (or advocatemcp.com once DNS is routed).
# Override with --url if you deploy to a different worker name.
PRODUCTION_URL="https://advocatecameron.workers.dev"

EMAIL="" PASSWORD="" NAME="" SLUG="" BIZ_NAME="" API_KEY="" ADMIN_SECRET="" URL="$PRODUCTION_URL"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)          EMAIL="$2";        shift 2;;
    --password)       PASSWORD="$2";     shift 2;;
    --name)           NAME="$2";         shift 2;;
    --slug)           SLUG="$2";         shift 2;;
    --biz-name)       BIZ_NAME="$2";     shift 2;;
    --api-key)        API_KEY="$2";      shift 2;;
    --admin-secret)   ADMIN_SECRET="$2"; shift 2;;
    --url)            URL="$2";          shift 2;;
    *) echo "Unknown flag: $1"; exit 1;;
  esac
done

if [[ -z "$EMAIL" || -z "$PASSWORD" || -z "$SLUG" || -z "$BIZ_NAME" || -z "$API_KEY" || -z "$ADMIN_SECRET" ]]; then
  echo "Error: --email, --password, --slug, --biz-name, --api-key, and --admin-secret are required."
  exit 1
fi

curl -s -X POST "${URL}/admin/create-client" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${ADMIN_SECRET}" \
  -d "$(jq -n \
    --arg email       "$EMAIL" \
    --arg password    "$PASSWORD" \
    --arg full_name   "$NAME" \
    --arg slug        "$SLUG" \
    --arg business_name "$BIZ_NAME" \
    --arg api_key     "$API_KEY" \
    '{email:$email,password:$password,full_name:$full_name,slug:$slug,business_name:$business_name,api_key:$api_key}')" \
  | jq .
