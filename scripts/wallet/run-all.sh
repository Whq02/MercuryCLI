#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/models/wallet/** src/platform/secure-storage/**
# gate-watch: src/models/sign-in/account-ledger/credentialIdentity.ts src/models/roads/cerebras/cerebrasAccounts.ts src/models/roads/cohere/cohereAccounts.ts src/models/roads/deepseek/deepseekAccounts.ts src/models/roads/fireworks/fireworksAccounts.ts src/models/roads/gemini/geminiAccounts.ts src/models/roads/groq/groqAccounts.ts src/models/roads/huggingface/huggingfaceAccounts.ts src/models/roads/local/localAccounts.ts src/models/roads/melious/meliousAccounts.ts src/models/roads/meta/metaAccounts.ts src/models/roads/minimax/minimaxAccounts.ts src/models/roads/mistral/mistralAccounts.ts src/models/roads/moonshot/moonshotAccounts.ts src/models/roads/nous/nousAccounts.ts src/models/roads/openai/openaiAccounts.ts src/models/roads/openaicompat/compatAccounts.ts src/models/roads/openrouter/openrouterAccounts.ts src/models/roads/orcarouter/orcarouterAccounts.ts src/models/roads/qwen/qwenAccounts.ts src/models/roads/together/togetherAccounts.ts src/models/roads/xai/xaiAccounts.ts src/models/roads/zai/zaiAccounts.ts src/models/roads/zen/zenAccounts.ts src/models/roads/anthropic/anthropicLogin.ts src/models/roads/cerebras/cerebrasLogin.ts src/models/roads/cohere/cohereLogin.ts src/models/roads/deepseek/deepseekLogin.ts src/models/roads/fireworks/fireworksLogin.ts src/models/roads/gemini/geminiLogin.ts src/models/roads/groq/groqLogin.ts src/models/roads/huggingface/huggingfaceLogin.ts src/models/roads/melious/meliousLogin.ts src/models/roads/meta/metaLogin.ts src/models/roads/minimax/minimaxLogin.ts src/models/roads/mistral/mistralLogin.ts src/models/roads/moonshot/moonshotLogin.ts src/models/roads/nous/nousLogin.ts src/models/roads/openai/openaiLogin.ts src/models/roads/openaicompat/compatLogin.ts src/models/roads/openrouter/openrouterLogin.ts src/models/roads/orcarouter/orcarouterLogin.ts src/models/roads/qwen/qwenLogin.ts src/models/roads/together/togetherLogin.ts src/models/roads/xai/xaiLogin.ts src/models/roads/zai/zaiLogin.ts src/models/roads/zen/zenLogin.ts src/models/sign-in/oauth/auth-code-listener.ts src/models/sign-in/oauth/client.ts src/models/sign-in/oauth/crypto.ts src/models/sign-in/oauth/index.ts src/models/sign-in/oauth/refresh.ts src/models/sign-in/account-ledger/**
# gate-watch: src/screen/renderer/stringWidth.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/wallet"
fail=0
drive_members wallet 'scripts/wallet/$name' "$here/members.txt" || fail=1
if [ "$fail" = "0" ]; then echo "✅ WALLET SUITE GREEN"; else echo "❌ WALLET SUITE RED"; fi
exit "$fail"
