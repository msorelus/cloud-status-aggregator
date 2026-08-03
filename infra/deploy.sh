#!/usr/bin/env bash
# =============================================================================
# Deploy without Azure Developer CLI.
#
#   ./infra/deploy.sh <environment-name> [location]
#
# `azd up` is the supported path and does all of this for you. This script
# exists for environments where azd cannot be installed. It drives exactly the
# same Bicep templates, in the same two passes azd uses:
#
#   pass 1  provision  — resource group, registry, identity, Key Vault,
#                        Container Apps environment, app on a placeholder image
#   build              — az acr build (server side; no local Docker needed)
#   pass 2  deploy     — re-run the template with the real image
#
# Optional environment variables:
#   SUBSCRIPTION_IDS   comma-separated subscription IDs for Service Health
#   WEBHOOK_URL        endpoint that receives change notifications
#   WEBHOOK_SECRET     HMAC-SHA256 signing key (generate: openssl rand -hex 32)
#   IMAGE_TAG          image tag (default: current UTC timestamp)
#   DEPLOY_TIER        dev | test | staging | prod (default: dev)
#   RESOURCE_GROUP     deploy into an existing group instead of rg-<env-name>
# =============================================================================
set -euo pipefail

ENV_NAME="${1:-}"
LOCATION="${2:-eastus2}"

if [[ -z "$ENV_NAME" ]]; then
  echo "usage: ./infra/deploy.sh <environment-name> [location]" >&2
  echo "  e.g. ./infra/deploy.sh csa-dev eastus2" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/main.bicep"

DEPLOY_TIER="${DEPLOY_TIER:-dev}"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%d%H%M%S)}"
IMAGE_REPO="cloud-status-aggregator"
RESOURCE_GROUP="${RESOURCE_GROUP:-}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

common_params=(
  environmentName="$ENV_NAME"
  location="$LOCATION"
  environment="$DEPLOY_TIER"
  resourceGroupName="$RESOURCE_GROUP"
  subscriptionIds="${SUBSCRIPTION_IDS:-}"
  webhookUrl="${WEBHOOK_URL:-}"
  webhookSecret="${WEBHOOK_SECRET:-}"
)

say "Checking Azure CLI login"
az account show --query '{subscription:name, id:id, user:user.name}' -o table

# Granting the caller AcrPush means the image can be pushed with the operator's
# own identity instead of enabling the registry admin account.
PRINCIPAL_ID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo '')"
PRINCIPAL_TYPE="User"
if [[ -z "$PRINCIPAL_ID" ]]; then
  PRINCIPAL_ID="$(az account show --query user.name -o tsv)"
  PRINCIPAL_ID="$(az ad sp show --id "$PRINCIPAL_ID" --query id -o tsv 2>/dev/null || echo '')"
  PRINCIPAL_TYPE="ServicePrincipal"
fi

say "Pass 1 of 2: provisioning infrastructure"
az deployment sub create \
  --name "csa-provision-$IMAGE_TAG" \
  --location "$LOCATION" \
  --template-file "$TEMPLATE" \
  --parameters "${common_params[@]}" \
  --parameters principalId="$PRINCIPAL_ID" principalType="$PRINCIPAL_TYPE" \
  --output none

read_output() {
  az deployment sub show --name "csa-provision-$IMAGE_TAG" \
    --query "properties.outputs.$1.value" -o tsv
}

RG="$(read_output AZURE_RESOURCE_GROUP)"
ACR_NAME="$(read_output AZURE_CONTAINER_REGISTRY_NAME)"
LOGIN_SERVER="$(read_output AZURE_CONTAINER_REGISTRY_ENDPOINT)"

say "Building $IMAGE_REPO:$IMAGE_TAG in $ACR_NAME with ACR Tasks"
az acr build \
  --registry "$ACR_NAME" \
  --resource-group "$RG" \
  --image "$IMAGE_REPO:$IMAGE_TAG" \
  --image "$IMAGE_REPO:latest" \
  --file "$REPO_ROOT/Dockerfile" \
  "$REPO_ROOT"

CONTAINER_IMAGE="${LOGIN_SERVER}/${IMAGE_REPO}:${IMAGE_TAG}"

say "Pass 2 of 2: rolling out $CONTAINER_IMAGE"
az deployment sub create \
  --name "csa-deploy-$IMAGE_TAG" \
  --location "$LOCATION" \
  --template-file "$TEMPLATE" \
  --parameters "${common_params[@]}" \
  --parameters principalId="$PRINCIPAL_ID" principalType="$PRINCIPAL_TYPE" \
  --parameters apiExists=true containerImage="$CONTAINER_IMAGE" \
  --output none

API_URL="$(az deployment sub show --name "csa-deploy-$IMAGE_TAG" \
  --query "properties.outputs.apiUrl.value" -o tsv)"

say "Deployed"
cat <<EOF

  Resource group ${RG}
  Image          ${CONTAINER_IMAGE}

  Status view    ${API_URL}/api/status/view
  Raw status     ${API_URL}/api/status
  Recent changes ${API_URL}/api/status/changes
  MCP endpoint   ${API_URL}/mcp
  Health probe   ${API_URL}/healthz

  Smoke test:
    curl -s ${API_URL}/api/status | jq '{mock, overall, sources}'

EOF
