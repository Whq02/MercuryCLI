#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/models/hosting/** src/commands/llmhost/words.ts vendor/node.lock.json src/commands/imagesetup/** src/screen/settings/Config.tsx src/models/local-server/localServerTruth.ts
# gate-watch: src/integrations/extensions/active.ts src/integrations/extensions/blocklist.ts src/integrations/extensions/boot.ts src/integrations/extensions/bundled/** src/integrations/extensions/card.ts src/integrations/extensions/catalogue.ts src/integrations/extensions/cli.ts src/integrations/extensions/health.ts src/integrations/extensions/install.ts src/integrations/extensions/installConsent.ts src/integrations/extensions/load/agents.ts src/integrations/extensions/load/commands.ts src/integrations/extensions/load/contributions.ts src/integrations/extensions/load/hooks.ts src/integrations/extensions/load/keybindings.ts src/integrations/extensions/load/language.ts src/integrations/extensions/load/optionSchema.ts src/integrations/extensions/load/servers.ts src/integrations/extensions/manifest.ts src/integrations/extensions/options.ts src/integrations/extensions/paths.ts src/integrations/extensions/records.ts src/integrations/extensions/reload.ts src/integrations/extensions/roster.ts src/integrations/extensions/sources.ts src/integrations/extensions/tree.ts src/integrations/extensions/types.ts src/integrations/extensions/validate.ts
# gate-watch: src/screen/themedRenderer.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/media"
fail=0
drive_members media 'scripts/media/$name' "$here/members.txt" || fail=1
exit "$fail"
