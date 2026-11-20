import { maskedKeyTail } from './credentialIdentity.js'
import {
  buildProviderSnapshot,
  type ProviderSnapshot,
} from './modelRegistry.js'
import {
  providerFamilyPresences,
} from './providerUsage.js'
import type { FamilySlotGroup, AccountSlotReads } from './accountSlots/shapes.js'
export type { SlotRemoval, AccountSlot, FamilySlotGroup, AccountSlotReads, SlotRemovalOwners } from './accountSlots/shapes.js'
export { familyDisplayName, familySigninCeiling, type SlotIdentityRead, type SlotIdentities, type SlotSigninBasis, type SlotSigninState, slotSigninState, scopeSlotTail, familyRouteWords, familyAbsentWords, type FamilySigninSummary, familySigninSummary, familySigninCount, type SigninCeilingRefusal, signinCeilingRefusal } from './accountSlots/signin.js'
export { type MainLoopIdentityBasis, type MainLoopIdentity, type MainLoopIdentityInput, mainLoopIdentity } from './accountSlots/mainLoopIdentity.js'
import { mistralSlots, nousSlots, zenSlots, minimaxSlots, togetherSlots, cohereSlots, groqSlots, meliousSlots, orcarouterSlots, cerebrasSlots, fireworksSlots, qwenSlots, deepseekSlots } from './accountSlots/keyLane.js'
export { looksLikeProofFixtureKey } from './accountSlots/keyLane.js'
import { anthropicSlots } from './accountSlots/anthropic.js'
import { openaiSlots } from './accountSlots/openai.js'
import { zaiSlots } from './accountSlots/zai.js'
import { openrouterSlots } from './accountSlots/openrouter.js'
export { openrouterSlots } from './accountSlots/openrouter.js'
import { geminiSlots } from './accountSlots/gemini.js'
import { moonshotSlots } from './accountSlots/moonshot.js'
import { metaSlots } from './accountSlots/meta.js'
import { xaiSlots } from './accountSlots/xai.js'
import { compatSlots } from './accountSlots/compat.js'
import { huggingfaceSlots } from './accountSlots/huggingface.js'
import { localSlots } from './accountSlots/local.js'
import { genericSlots } from './accountSlots/generic.js'
export { type AnthropicSlotSignOutIo, signOutAnthropicSlot, executeSlotRemoval, signOutEveryEngineCredential } from './accountSlots/removal.js'

export { maskedKeyTail }


export function deriveFamilySlotGroups(
  providers: ProviderSnapshot['providers'] = buildProviderSnapshot().providers,
  reads: AccountSlotReads = {},
): FamilySlotGroup[] {
  const presences = providerFamilyPresences(providers, reads.familyReads)
  return presences
    .map(family => {
      const slots =
        family.id === 'anthropic'
          ? anthropicSlots(reads)
          : family.id === 'openai'
            ? openaiSlots(reads)
            : family.id === 'zai'
              ? zaiSlots(reads)
              : family.id === 'openrouter'
                ? openrouterSlots(reads)
                : family.id === 'gemini'
                  ? geminiSlots(reads)
                  : family.id === 'moonshot'
                    ? moonshotSlots(reads)
                    : family.id === 'deepseek'
                      ? deepseekSlots(reads)
                      : family.id === 'xai'
                        ? xaiSlots(reads)
                        : family.id === 'meta'
                          ? metaSlots(reads)
                          : family.id === 'zen'
                            ? zenSlots(reads)
                          : family.id === 'minimax'
                            ? minimaxSlots(reads)
                          : family.id === 'together'
                            ? togetherSlots(reads)
                          : family.id === 'cohere'
                            ? cohereSlots(reads)
                          : family.id === 'groq'
                            ? groqSlots(reads)
                          : family.id === 'melious'
                            ? meliousSlots(reads)
                          : family.id === 'orcarouter'
                            ? orcarouterSlots(reads)
                          : family.id === 'cerebras'
                            ? cerebrasSlots(reads)
                          : family.id === 'fireworks'
                            ? fireworksSlots(reads)
                          : family.id === 'qwen'
                            ? qwenSlots(reads)
                          : family.id === 'openai-compat'
                            ? compatSlots(reads)
                            : family.id === 'huggingface'
                              ? huggingfaceSlots(reads)
                              : family.id === 'local'
                                ? localSlots(reads)
                                : family.id === 'mistral'
                                  ? mistralSlots(reads)
                                  : family.id === 'nous'
                                    ? nousSlots(reads)
                                    : genericSlots(
                                    family,
                                    providers.find(provider => provider.id === family.id),
                                  )
      return { family, slots }
    })
}

