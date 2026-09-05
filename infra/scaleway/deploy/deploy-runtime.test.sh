#!/usr/bin/env bash

set -u -o pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
subject="$script_dir/deploy-runtime.sh"
temporary_directory=$(mktemp -d)
mock_bin="$temporary_directory/bin"
failures=0

trap 'rm -rf "$temporary_directory"' EXIT

mkdir -p "$mock_bin"

cat >"$mock_bin/scw" <<'MOCK'
#!/usr/bin/env bash

set -euo pipefail

if [[ "${1:-}" != "container" || "${2:-}" != "container" ]]; then
  exit 64
fi

action=${3:-}
case "$action" in
  get)
    count=0
    if [[ -f "$SCW_MOCK_DIR/get-count" ]]; then
      count=$(<"$SCW_MOCK_DIR/get-count")
    fi
    count=$((count + 1))
    printf '%s' "$count" >"$SCW_MOCK_DIR/get-count"

    image=$(<"$SCW_MOCK_DIR/current-image")
    if [[ "$count" -eq 2 && -n "${SCW_MOCK_VERIFICATION_IMAGE:-}" ]]; then
      image=$SCW_MOCK_VERIFICATION_IMAGE
    fi
    printf '{"image":"%s"}\n' "$image"
    ;;
  update)
    image=
    for argument in "$@"; do
      case "$argument" in
        image=*)
          image=${argument#image=}
          ;;
      esac
    done
    [[ -n "$image" ]] || exit 64

    printf '%s\n' "$image" >>"$SCW_MOCK_DIR/update-log"
    count=0
    if [[ -f "$SCW_MOCK_DIR/update-count" ]]; then
      count=$(<"$SCW_MOCK_DIR/update-count")
    fi
    count=$((count + 1))
    printf '%s' "$count" >"$SCW_MOCK_DIR/update-count"

    if [[ "$count" == "${SCW_MOCK_UPDATE_FAILURE_AT:-}" ]]; then
      exit 1
    fi
    printf '%s' "$image" >"$SCW_MOCK_DIR/current-image"
    printf '{"image":"%s"}\n' "$image"
    ;;
  *)
    exit 64
    ;;
esac
MOCK

cat >"$mock_bin/curl" <<'MOCK'
#!/usr/bin/env bash

set -euo pipefail

printf '%s\n' "$*" >>"$SCW_MOCK_DIR/curl-log"
exit "${SCW_MOCK_CURL_EXIT:-0}"
MOCK

chmod +x "$mock_bin/scw" "$mock_bin/curl"

setup_case() {
  local name=$1

  case_directory="$temporary_directory/$name"
  mkdir -p "$case_directory"
  printf '%s' "registry.example/previous:sha" >"$case_directory/current-image"
  : >"$case_directory/update-log"
  : >"$case_directory/curl-log"
}

invoke_deploy() {
  local runtime=$1
  local image=$2
  shift 2

  output=$(
    env \
      PATH="$mock_bin:$PATH" \
      SCW_INGRESS_CONTAINER_ID=ingress-id \
      SCW_MOCK_DIR="$case_directory" \
      SCW_REGION=nl-ams \
      SCW_WORKER_CONTAINER_ID=worker-id \
      "$@" \
      "$subject" "$runtime" "$image" 2>&1
  )
  status=$?
}

assert_equal() {
  local expected=$1
  local actual=$2
  local description=$3

  if [[ "$actual" != "$expected" ]]; then
    printf '  %s: expected <%s>, got <%s>\n' "$description" "$expected" "$actual" >&2
    return 1
  fi
}

assert_contains() {
  local expected=$1
  local actual=$2
  local description=$3

  if [[ "$actual" != *"$expected"* ]]; then
    printf '  %s: expected output to contain <%s>\n' "$description" "$expected" >&2
    return 1
  fi
}

test_dry_run() {
  setup_case dry-run
  invoke_deploy \
    ingress \
    registry.example/ingress:new \
    DEPLOY_DRY_RUN=true \
    DEPLOY_HEALTH_URL=https://example.invalid/health

  assert_equal 0 "$status" "exit status" || return
  assert_contains \
    "Would deploy ingress from registry.example/previous:sha to registry.example/ingress:new." \
    "$output" \
    "dry-run message" || return
  assert_equal "" "$(<"$case_directory/update-log")" "updates" || return
  assert_equal "" "$(<"$case_directory/curl-log")" "health checks" || return
  assert_equal \
    "registry.example/previous:sha" \
    "$(<"$case_directory/current-image")" \
    "current image"
}

test_successful_update() {
  setup_case successful-update
  invoke_deploy worker registry.example/worker:new

  assert_equal 0 "$status" "exit status" || return
  assert_contains \
    "Deployed worker to registry.example/worker:new." \
    "$output" \
    "success message" || return
  assert_equal \
    "registry.example/worker:new" \
    "$(<"$case_directory/update-log")" \
    "updates" || return
  assert_equal \
    "registry.example/worker:new" \
    "$(<"$case_directory/current-image")" \
    "current image"
}

test_update_failure_rolls_back() {
  setup_case update-failure
  invoke_deploy \
    worker \
    registry.example/worker:new \
    SCW_MOCK_UPDATE_FAILURE_AT=1

  assert_equal 1 "$status" "exit status" || return
  assert_contains \
    "Deployment failed; restoring worker to registry.example/previous:sha." \
    "$output" \
    "rollback message" || return
  assert_equal \
    $'registry.example/worker:new\nregistry.example/previous:sha' \
    "$(<"$case_directory/update-log")" \
    "updates" || return
  assert_equal \
    "registry.example/previous:sha" \
    "$(<"$case_directory/current-image")" \
    "current image"
}

test_image_verification_failure_rolls_back() {
  setup_case image-verification-failure
  invoke_deploy \
    worker \
    registry.example/worker:new \
    SCW_MOCK_VERIFICATION_IMAGE=registry.example/unexpected:sha

  assert_equal 1 "$status" "exit status" || return
  assert_contains \
    "Scaleway reports unexpected image registry.example/unexpected:sha." \
    "$output" \
    "verification message" || return
  assert_equal \
    $'registry.example/worker:new\nregistry.example/previous:sha' \
    "$(<"$case_directory/update-log")" \
    "updates" || return
  assert_equal \
    "registry.example/previous:sha" \
    "$(<"$case_directory/current-image")" \
    "current image"
}

test_ingress_health_failure_rolls_back() {
  setup_case ingress-health-failure
  invoke_deploy \
    ingress \
    registry.example/ingress:new \
    DEPLOY_HEALTH_URL=https://ingress.example/health \
    SCW_MOCK_CURL_EXIT=22

  assert_equal 1 "$status" "exit status" || return
  assert_contains \
    "Health check failed for https://ingress.example/health." \
    "$output" \
    "health failure message" || return
  assert_contains \
    "https://ingress.example/health" \
    "$(<"$case_directory/curl-log")" \
    "health request" || return
  assert_equal \
    $'registry.example/ingress:new\nregistry.example/previous:sha' \
    "$(<"$case_directory/update-log")" \
    "updates" || return
  assert_equal \
    "registry.example/previous:sha" \
    "$(<"$case_directory/current-image")" \
    "current image"
}

report_result() {
  local result=$1
  local name=$2

  if [[ "$result" -eq 0 ]]; then
    printf 'ok - %s\n' "$name"
  else
    printf 'not ok - %s\n' "$name"
    failures=$((failures + 1))
  fi
}

printf '1..5\n'
test_dry_run
report_result "$?" "dry run does not mutate the runtime"
test_successful_update
report_result "$?" "successful update keeps the new image"
test_update_failure_rolls_back
report_result "$?" "update failure restores the previous image"
test_image_verification_failure_rolls_back
report_result "$?" "image verification failure restores the previous image"
test_ingress_health_failure_rolls_back
report_result "$?" "ingress health failure restores the previous image"

exit "$failures"
