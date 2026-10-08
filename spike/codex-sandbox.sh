#!/usr/bin/env bash
set -euo pipefail

# Tests Codex's local sandbox command only; no provider request or target code.
worker_image='wpbounty-worker-codex@sha256:376fb1363ce4c3050de5b6e296d912be88bf129c6101421c8ca5c0790903d69f'
codex_binary="$(command -v codex)"
bundled_bwrap='/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources'
base=(docker run --rm --pull=never --runtime=runsc --network=none
  --volume="${codex_binary}:/usr/local/bin/codex-new:ro"
  "--env=PATH=${bundled_bwrap}:/usr/local/bin:/usr/bin:/bin"
  --entrypoint=/usr/local/bin/codex-new "$worker_image")

"${base[@]}" --version
set +e
"${base[@]}" sandbox -- /bin/true
read_only_status=$?
"${base[@]}" sandbox -c 'sandbox_mode="danger-full-access"' -- /bin/true
outer_only_status=$?
set -e
printf 'read_only_exit=%s\nouter_only_exit=%s\n' "$read_only_status" "$outer_only_status"
