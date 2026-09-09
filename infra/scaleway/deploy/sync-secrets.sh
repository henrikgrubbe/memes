#!/usr/bin/env bash

# Pushes the secrets 1Password holds into GitHub, which is the only copy CI can
# read.
#
# GitHub secrets are write-only: nothing can read them back to compare, so
# there is no way to detect that a value has drifted from the one in
# 1Password. That is not a gap this script can close - it is the reason the
# sync has to run in one direction only. A webhook secret that was edited in
# GitHub but not in 1Password took the meme pipeline down for a morning, and
# the failure was invisible until a container rejected every request.
#
# So: 1Password is the source of truth, this script is the only way values
# reach GitHub, and nothing is written by hand in the GitHub UI.

set -euo pipefail

repository=${SECRETS_REPOSITORY:-henrikgrubbe/memes}
env_file=${SECRETS_ENV_FILE:-.env.scaleway}
dry_run=${DRY_RUN:-false}

# Repository-wide secrets. infra-tofu.yml reads these on every plan and apply,
# so they cannot live on a single environment.
repository_secrets=(
  "GH_WEBHOOK_SECRET:GH_WEBHOOK_SECRET"
  "GH_API_TOKEN:GH_API_TOKEN"
  "SLACK_WEBHOOK_URL:SLACK_WEBHOOK_URL"
  "AI_PROVIDER_OPENAI_API_KEY:AI_PROVIDER_OPENAI_API_KEY"
  "AI_PROVIDER_XAI_API_KEY:AI_PROVIDER_XAI_API_KEY"
)

# Each environment holds a different Scaleway identity under the same two
# names, which is what keeps an image deploy from carrying apply rights.
environment_secrets=(
  "SCW_RUNTIME_DEPLOY_ACCESS_KEY:production:SCW_ACCESS_KEY"
  "SCW_RUNTIME_DEPLOY_SECRET_KEY:production:SCW_SECRET_KEY"
  "SCW_INFRA_APPLY_ACCESS_KEY:infra-production:SCW_ACCESS_KEY"
  "SCW_INFRA_APPLY_SECRET_KEY:infra-production:SCW_SECRET_KEY"
  "SCW_INFRA_DRIFT_ACCESS_KEY:infra-drift:SCW_ACCESS_KEY"
  "SCW_INFRA_DRIFT_SECRET_KEY:infra-drift:SCW_SECRET_KEY"
)

for tool in gh; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'The %s CLI is required.\n' "$tool" >&2
    exit 2
  }
done

if [[ ! -r "$env_file" ]]; then
  printf 'Cannot read %s. Mount the 1Password environment first.\n' "$env_file" >&2
  exit 2
fi

# The mount is a named pipe, so `source` silently yields empty values and a
# second read can block. Read it exactly once, through cat, into this shell.
# Kept as plain text rather than an associative array so the script still runs
# on the bash 3.2 that ships with macOS, where `declare -A` does not exist.
mounted_values=$(cat -- "$env_file")

value_for() {
  local name=$1 line
  while IFS= read -r line; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue
    if [[ "${line%%=*}" == "$name" ]]; then
      printf '%s' "${line#*=}"
      return 0
    fi
  done <<<"$mounted_values"
  return 1
}

if [[ -z "${mounted_values//[[:space:]]/}" ]]; then
  printf 'Read no values from %s. Is the 1Password environment mounted?\n' "$env_file" >&2
  exit 1
fi

# Collect every missing name before writing anything. A partial sync is how
# two copies drift, so it is better to write nothing and say what is absent.
missing=()
for mapping in "${repository_secrets[@]}" "${environment_secrets[@]}"; do
  source_name=${mapping%%:*}
  [[ -n "$(value_for "$source_name")" ]] || missing+=("$source_name")
done

if [[ ${#missing[@]} -gt 0 ]]; then
  printf 'The 1Password environment is missing:\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  printf '\nAdd them, then run this again. Nothing was written.\n' >&2
  exit 1
fi

set_secret() {
  local name=$1 value=$2
  shift 2
  if [[ "$dry_run" == "true" ]]; then
    printf 'Would set %s%s.\n' "$name" "${1:+ on $2}"
    return 0
  fi
  # The value goes over stdin rather than --body so it never appears in the
  # process table, and printf omits the trailing newline gh would otherwise
  # store as part of the secret.
  printf '%s' "$value" | gh secret set "$name" --repo "$repository" "$@"
}

for mapping in "${repository_secrets[@]}"; do
  source_name=${mapping%%:*}
  target_name=${mapping##*:}
  set_secret "$target_name" "$(value_for "$source_name")"
  printf 'Synced %s.\n' "$target_name"
done

for mapping in "${environment_secrets[@]}"; do
  source_name=${mapping%%:*}
  remainder=${mapping#*:}
  environment=${remainder%%:*}
  target_name=${remainder##*:}
  set_secret "$target_name" "$(value_for "$source_name")" --env "$environment"
  printf 'Synced %s on %s.\n' "$target_name" "$environment"
done

printf '\nGitHub now matches 1Password. Rotations must start in 1Password and\n'
printf 'come back through this script, never through the GitHub UI.\n'
