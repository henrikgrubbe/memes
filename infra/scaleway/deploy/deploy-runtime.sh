#!/usr/bin/env bash

set -euo pipefail

runtime=${1:-}
image=${2:-}

case "$runtime" in
  ingress)
    container_id=${SCW_INGRESS_CONTAINER_ID:-}
    ;;
  worker)
    container_id=${SCW_WORKER_CONTAINER_ID:-}
    ;;
  *)
    printf 'Usage: %s <ingress|worker> <image>\n' "$0" >&2
    exit 2
    ;;
esac

if [[ -z "$image" || -z "$container_id" || -z "${SCW_REGION:-}" ]]; then
  printf 'Image, container ID, and SCW_REGION are required.\n' >&2
  exit 2
fi

command -v scw >/dev/null 2>&1 || {
  printf 'The Scaleway CLI is required.\n' >&2
  exit 2
}
command -v jq >/dev/null 2>&1 || {
  printf 'jq is required.\n' >&2
  exit 2
}

get_image() {
  scw container container get "$container_id" \
    region="$SCW_REGION" \
    -o json |
    jq -er '.image'
}

previous_image=$(get_image)

if [[ "${DEPLOY_DRY_RUN:-false}" == "true" ]]; then
  printf 'Would deploy %s from %s to %s.\n' "$runtime" "$previous_image" "$image"
  exit 0
fi

rollback() {
  printf 'Deployment failed; restoring %s to %s.\n' "$runtime" "$previous_image" >&2
  scw container container update "$container_id" \
    image="$previous_image" \
    region="$SCW_REGION" \
    --wait \
    -o json >/dev/null
}

printf 'Deploying %s from %s to %s.\n' "$runtime" "$previous_image" "$image"
if ! scw container container update "$container_id" \
  image="$image" \
  region="$SCW_REGION" \
  --wait \
  -o json >/dev/null; then
  rollback
  exit 1
fi

if ! deployed_image=$(get_image); then
  printf 'Could not verify the deployed image.\n' >&2
  rollback
  exit 1
fi
if [[ "$deployed_image" != "$image" ]]; then
  printf 'Scaleway reports unexpected image %s.\n' "$deployed_image" >&2
  rollback
  exit 1
fi

if [[ -n "${DEPLOY_HEALTH_URL:-}" ]] &&
  ! curl --fail --silent --show-error \
    --retry 5 \
    --retry-all-errors \
    --retry-delay 3 \
    "$DEPLOY_HEALTH_URL"; then
  printf 'Health check failed for %s.\n' "$DEPLOY_HEALTH_URL" >&2
  rollback
  exit 1
fi

printf 'Deployed %s to %s.\n' "$runtime" "$deployed_image"
