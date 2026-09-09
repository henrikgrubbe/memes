#!/usr/bin/env bash

set -u -o pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
subject="$script_dir/sync-secrets.sh"
temporary_directory=$(mktemp -d)
mock_bin="$temporary_directory/bin"
failures=0

trap 'rm -rf "$temporary_directory"' EXIT

mkdir -p "$mock_bin"

# Records what it was asked to set, and the value it received on stdin, so a
# test can assert the mapping without a real repository.
cat >"$mock_bin/gh" <<'MOCK'
#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" != "secret" || "${2:-}" != "set" ]]; then
  exit 64
fi

name=$3
environment=""
shift 3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      environment=$2
      shift 2
      ;;
    --repo)
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

value=$(cat)
printf '%s|%s|%s\n' "$name" "$environment" "$value" >>"$GH_MOCK_LOG"
MOCK
chmod +x "$mock_bin/gh"

complete_environment() {
  cat <<'ENV'
GH_WEBHOOK_SECRET=hook-secret
GH_API_TOKEN=github_pat_value
SLACK_WEBHOOK_URL=https://example.invalid/hook
AI_PROVIDER_OPENAI_API_KEY=openai-value
AI_PROVIDER_XAI_API_KEY=xai-value
SCW_RUNTIME_DEPLOY_ACCESS_KEY=deploy-access
SCW_RUNTIME_DEPLOY_SECRET_KEY=deploy-secret
SCW_INFRA_APPLY_ACCESS_KEY=apply-access
SCW_INFRA_APPLY_SECRET_KEY=apply-secret
SCW_INFRA_DRIFT_ACCESS_KEY=drift-access
SCW_INFRA_DRIFT_SECRET_KEY=drift-secret
ENV
}

run_sync() {
  local env_file=$1
  shift
  PATH="$mock_bin:$PATH" \
    GH_MOCK_LOG="$temporary_directory/gh.log" \
    SECRETS_ENV_FILE="$env_file" \
    SECRETS_REPOSITORY="owner/repo" \
    "$@" "$subject" 2>"$temporary_directory/stderr" >"$temporary_directory/stdout"
}

expect() {
  local description=$1 expected=$2 actual=$3
  if [[ "$expected" != "$actual" ]]; then
    printf 'FAIL %s\n  expected: %s\n  actual:   %s\n' "$description" "$expected" "$actual" >&2
    failures=$((failures + 1))
  else
    printf 'ok %s\n' "$description"
  fi
}

# Every secret reaches the right name, and the environment-scoped Scaleway keys
# land on separate environments under the same name.
: >"$temporary_directory/gh.log"
complete_environment >"$temporary_directory/complete.env"
run_sync "$temporary_directory/complete.env" env
expect "syncs every secret" "11" "$(wc -l <"$temporary_directory/gh.log" | tr -d ' ')"
expect "maps the webhook secret" \
  "GH_WEBHOOK_SECRET||hook-secret" \
  "$(grep '^GH_WEBHOOK_SECRET|' "$temporary_directory/gh.log")"
expect "gives production the deploy key" \
  "SCW_ACCESS_KEY|production|deploy-access" \
  "$(grep '^SCW_ACCESS_KEY|production|' "$temporary_directory/gh.log")"
expect "gives infra-production the apply key" \
  "SCW_ACCESS_KEY|infra-production|apply-access" \
  "$(grep '^SCW_ACCESS_KEY|infra-production|' "$temporary_directory/gh.log")"
expect "gives infra-drift the read-only key" \
  "SCW_ACCESS_KEY|infra-drift|drift-access" \
  "$(grep '^SCW_ACCESS_KEY|infra-drift|' "$temporary_directory/gh.log")"

# The deploy identity must never be handed apply rights by a copy-paste slip.
deploy_secret=$(grep '^SCW_SECRET_KEY|production|' "$temporary_directory/gh.log")
expect "never gives production the apply secret" \
  "SCW_SECRET_KEY|production|deploy-secret" "$deploy_secret"

# A partial sync is how two copies drift, so an incomplete environment must
# write nothing at all rather than most of it.
: >"$temporary_directory/gh.log"
complete_environment | grep -v '^AI_PROVIDER_XAI_API_KEY=' >"$temporary_directory/partial.env"
run_sync "$temporary_directory/partial.env" env
expect "refuses an incomplete environment" "1" "$?"
expect "writes nothing when a value is missing" "0" \
  "$(wc -l <"$temporary_directory/gh.log" | tr -d ' ')"
if ! grep -q 'AI_PROVIDER_XAI_API_KEY' "$temporary_directory/stderr"; then
  printf 'FAIL names the missing secret\n' >&2
  failures=$((failures + 1))
else
  printf 'ok names the missing secret\n'
fi

# An unmounted 1Password environment yields an empty file, which must not be
# read as "nothing to do".
: >"$temporary_directory/gh.log"
: >"$temporary_directory/empty.env"
run_sync "$temporary_directory/empty.env" env
expect "refuses an unmounted environment" "1" "$?"
expect "writes nothing when unmounted" "0" \
  "$(wc -l <"$temporary_directory/gh.log" | tr -d ' ')"

# A dry run has to be safe to hand to someone who wants to see the mapping.
: >"$temporary_directory/gh.log"
run_sync "$temporary_directory/complete.env" env DRY_RUN=true
expect "dry run writes nothing" "0" \
  "$(wc -l <"$temporary_directory/gh.log" | tr -d ' ')"
if grep -q 'hook-secret\|deploy-secret' "$temporary_directory/stdout"; then
  printf 'FAIL dry run must not print secret values\n' >&2
  failures=$((failures + 1))
else
  printf 'ok dry run keeps values out of its output\n'
fi

if [[ $failures -gt 0 ]]; then
  printf '\n%d assertion(s) failed.\n' "$failures" >&2
  exit 1
fi

printf '\nAll assertions passed.\n'
