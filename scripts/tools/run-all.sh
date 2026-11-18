#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/video/**
# gate-watch: src/utils/**
# gate-watch: src/tasks/stopTask* src/tasks/taskOutcomeEnvelope*
# gate-watch: src/*
# gate-watch: src/cli/headless/controlHandlers.ts src/components/*
# gate-watch: src/daemon/*
# gate-watch: src/hooks/*
# gate-watch: src/services/providers/*
# gate-watch: src/services/providers/openai/*
# gate-watch: src/components/messages/AttachmentMessage.tsx src/components/messages/TranscriptNameplate.tsx
# gate-watch: src/utils/hooks/contract.ts
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/cli/run.ts
# gate-watch: src/services/tools/earlyStarts.ts
# gate-watch: src/services/remoteFiles/** src/services/privateChannel/vendoredRuntime.ts
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss rc=%s\n' "$p" "$(( SECONDS - $2 ))" "${3:?proof exit code required}"; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun="${BUN:-$HOME/.bun/bin/bun}"
fail=0
for f in "$here"/prove-*.ts; do
  [ -e "$f" ] || continue
  __t=$SECONDS; __rc=0; "$bun" run "$f" || { __rc=$?; fail=1; }; prover_mark "$f" "$__t" "$__rc"
done
exit $fail
