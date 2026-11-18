#!/usr/bin/env bash
# gate-class: pty
# gate-watch: src/components/ClickableImageRef.tsx src/components/FilePathLink.tsx src/components/MarkdownTable.tsx src/utils/sessionStoragePortable.ts src/utils/staticRender.tsx
# gate-watch: scripts/lib/seedTranscript.ts
# gate-watch: scripts/visual-contract/**
# gate-watch: assets/splash/** src/components/mercury-ui/** src/components/mercuryPalette.ts
# gate-watch: src/utils/mercuryTokens.ts src/utils/helmGeometry.ts src/utils/hyperlink.ts
# gate-watch: src/utils/earlyInput.ts src/hooks/usePasteHandler.ts
# gate-watch: README.md scripts/engine-durability/harness.ts scripts/lib/captureDriver.ts
# gate-watch: scripts/lib/firstRunSeed.ts scripts/ui/render-tui.ts scripts/ui/vshot.py
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/visual-contract-drives"
if [ ! -f dist/mercury.mjs ]; then
  printf '%s\n' 'visual-contract-drives: dist/mercury.mjs absent; build before running terminal drives'
  exit 1
fi

drive_members visual-contract-drives 'scripts/visual-contract/$name' "$here/members.txt"
