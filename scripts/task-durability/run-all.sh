#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: scripts/task-durability/**
# gate-watch: src/substrate/durablePublish.ts src/substrate/fileStore.ts src/utils/tasks.ts
# gate-watch: src/services/privateChannel/installLayout.ts src/utils/errors/classifyToolError.ts
# gate-watch: src/services/changeTransaction/changeSetCommit.ts .github/workflows/windows-functional.yml
# Owner artifacts exercised by these provers: the ONE durable publication
# primitive (src/substrate/durablePublish.ts — the win32 bounded-retry law
# WIN32_RENAME_RETRY_DELAYS_MS/isTransientWin32FsCode/renameRetryDelayMs, the
# typed result DurablePublishReport + DurablePublishError accounting, the
# extended MERCURY_FAULT_INJECT grammar `<phase>[@<sub>]:<throw|kill|errno>[#N]`,
# the shared helpers renameWithWin32Retry/Sync) · the task store defect
# surface (src/utils/tasks.ts → substrate publishAtomic) · the watcher-backed
# store kernel (src/substrate/fileStore.ts single-fire under retry) · the
# multi-file settlement step (src/services/changeTransaction/changeSetCommit.ts)
# · the updater reconciliation (src/services/privateChannel/installLayout.ts
# imports the law back) · the platform-honest EPERM/EACCES/EBUSY guidance
# (src/utils/errors/classifyToolError.ts; table proof also registered in the
# ui suite) · the windows-functional lane wiring (the win32-native arms of
# mo1-mo4 plus the real-open-handle mo6 run there).
# Windows file-publication reliability. Provers are
# glob-run so every landed prove-*.ts joins the gate automatically; win32-only
# arms SKIP LOUDLY on POSIX hosts and prove on the windows-functional runner.
set -u
# One wall-seconds line per prover — the pool engine reads exactly this shape.
prover_mark() { local p="$1"; case "$p" in */scripts/*) p="scripts/${p##*/scripts/}";; ./*) p="${p#./}";; esac; printf '── %s  %ss\n' "$p" "$(( SECONDS - $2 ))"; }

cd "$(dirname "$0")/../.." || exit 1
bun="${BUN:-$HOME/.bun/bin/bun}"

failed=0
shopt -s nullglob
for f in scripts/task-durability/prove-*.ts; do
  echo "── task-durability: $(basename "$f")"
  __t=$SECONDS; if ! "$bun" "$f"; then
    failed=1
  fi
  prover_mark "$f" "$__t"
done

exit "$failed"
