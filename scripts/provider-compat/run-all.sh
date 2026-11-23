#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/models/roads/openai/**
# gate-watch: src/models/roads/openaicompat/**
# gate-watch: src/models/roads/openrouter/** src/platform/settings/applySettingsChange.ts src/platform/settings/changeDetector.ts src/platform/settings/compatEndpoints.ts src/platform/settings/compatProvider.ts src/platform/settings/extensionOnlyPolicy.ts src/platform/settings/internalWrites.ts src/platform/settings/localSchema.ts src/platform/settings/managedPath.ts src/platform/settings/mdm/** src/platform/settings/modelFacts.ts src/platform/settings/permissionValidation.ts src/platform/settings/schemaOutput.ts src/platform/settings/settingSources.ts src/platform/settings/settings.ts src/platform/settings/settingsCache.ts src/platform/settings/settingsSchema.ts src/platform/settings/snapshot.ts src/platform/settings/toolValidationConfig.ts src/platform/settings/unknownKeyRemoval.ts src/platform/settings/validateSettingsEdit.ts src/platform/settings/validation.ts src/platform/settings/validationTips.ts
# gate-watch: src/models/roads/huggingface/** src/models/roads/local/**
# gate-watch: src/models/facts/pins/glmPins.ts src/models/roads/account-slots/** src/models/roads/accountSlots.ts src/models/roads/anthropic/anthropicAdapter.ts src/models/roads/anthropic/anthropicCatalogue.ts src/models/roads/anthropic/anthropicClient.ts src/models/roads/anthropic/anthropicLogin.ts src/models/roads/anthropic/anthropicStream.ts src/models/roads/anthropic/anthropicUsageState.ts src/models/roads/anthropic/anthropicWorkspace.ts src/models/roads/anthropic/boundPrefixRecord.ts src/models/roads/anthropic/cacheAndUsage.ts src/models/roads/anthropic/cacheDiagnostics.ts src/models/roads/anthropic/index.ts src/models/roads/anthropic/media.ts src/models/roads/anthropic/messageEffort.ts src/models/roads/anthropic/messageParams.ts src/models/roads/anthropic/modelRefusal.ts src/models/roads/anthropic/prefixLedger.ts src/models/roads/anthropic/prefixRecordStore.ts src/models/roads/anthropic/requestParams.ts src/models/roads/anthropic/stream-core/** src/models/roads/anthropic/streamCore.ts src/models/roads/anthropic/thinkingBinding.ts src/models/roads/anthropic/thinkingDisplay.ts src/models/roads/anthropic/toolIds.ts src/models/roads/anthropicRefusal.ts src/models/roads/busyRetry.ts src/models/roads/cacheFieldRetry.ts src/models/roads/callModelContract.ts src/models/roads/callModelRouter.ts src/models/roads/catalogueAdmission.ts src/models/roads/catalogueBody.ts src/models/roads/catalogueEpoch.ts src/models/roads/catalogueGate.ts src/models/roads/catalogueOnDemand.ts src/models/roads/cerebras/** src/models/roads/chatToolCallSlots.ts src/models/roads/cohere/** src/models/roads/credentialWall.ts src/models/roads/deepseek/** src/models/roads/deferralProbe.ts src/models/roads/deferralWire.ts src/models/roads/disabledProviders.ts src/models/roads/emptyReply.ts src/models/roads/emptyStreamRetry.ts src/models/roads/faultUsageEstimate.ts src/models/roads/fetchDeadline.ts src/models/roads/fireworks/** src/models/roads/gemini/** src/models/roads/groq/** src/models/roads/homeLaneAdmission.ts src/models/roads/huggingface/** src/models/roads/idSpaces.ts src/models/roads/laneBillingState.ts src/models/roads/laneWindowFact.ts src/models/roads/lawfulPrefixChange.ts src/models/roads/limitWarning.ts src/models/roads/local/** src/models/roads/localLiveness.ts src/models/roads/melious/** src/models/roads/meta/** src/models/roads/minimax/** src/models/roads/mistral/** src/models/roads/modelRegistry.ts src/models/roads/moonshot/** src/models/roads/nous/** src/models/roads/openai/** src/models/roads/openaicompat/** src/models/roads/openrouter/** src/models/roads/orcarouter/** src/models/roads/patience.ts src/models/roads/pdfBlock.ts src/models/roads/primaryBackend.ts src/models/roads/provider-usage/** src/models/roads/providerAdapter.ts src/models/roads/providerDiscovery.ts src/models/roads/providerIdentityLine.ts src/models/roads/providerKeyCommand.ts src/models/roads/providerUsability.ts src/models/roads/providerUsage.ts src/models/roads/qwen/** src/models/roads/registerCapabilities.ts src/models/roads/routeLaw.ts src/models/roads/signInRefusal.ts src/models/roads/slotSwitch.ts src/models/roads/slotSwitchReceipt.ts src/models/roads/spendSpelling.ts src/models/roads/sseDecoder.ts src/models/roads/streamIdleBudget.ts src/models/roads/temporaryStreamError.ts src/models/roads/together/** src/models/roads/toolCallGate.ts src/models/roads/toolEconomy.ts src/models/roads/transitionPreview.ts src/models/roads/typedModelIds.ts src/models/roads/usageFreshness.ts src/models/roads/usageTiers.ts src/models/roads/validate-model/** src/models/roads/validateModel.ts src/models/roads/xai/** src/models/roads/zai/** src/models/roads/zen/**
# gate-watch: src/engine/message-shapes/message.ts
# gate-watch: src/models/roads/gemini/** src/models/roads/xai/** src/models/roads/meta/**
# gate-watch: src/models/roads/mistral/**
# gate-watch: src/models/roads/zen/** src/models/roads/zen/zenAdapter.ts
# gate-watch: src/models/roads/groq/** src/models/roads/cerebras/** src/models/roads/fireworks/**
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
# gate-watch: src/models/roads/nous/**
# gate-watch: src/models/roads/minimax/** src/models/roads/together/** src/models/roads/cohere/**
# gate-watch: src/models/roads/melious/**
# gate-watch: src/engine/connector/seatLive.ts
# gate-watch: src/platform/health/healthReport.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/provider-compat"
fail=0
echo "############################################################"
echo "# provider-compat — multi-provider proof harness"
echo "############################################################"
echo "# Engine request contracts: prove-engine-shapes.ts and prove-tool-schemas-no-refs.ts"
drive_members provider-compat 'scripts/provider-compat/$name' "$here/members.txt" || fail=1
exit "$fail"
