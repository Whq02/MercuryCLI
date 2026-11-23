import { maskedKeyTail } from '../sign-in/account-ledger/credentialIdentity.js'
import {
  buildProviderSnapshot,
  type ProviderSnapshot,
} from './modelRegistry.js'
import {
  providerFamilyPresences,
} from './providerUsage.js'
import type { FamilySlotGroup, AccountSlotReads } from './account-slots/shapes.js'
export type { SlotRemoval, AccountSlot, FamilySlotGroup, AccountSlotReads, SlotRemovalOwners } from './account-slots/shapes.js'
export { familyDisplayName, familySigninCeiling, type SlotIdentityRead, type SlotIdentities, type SlotSigninBasis, type SlotSigninState, slotSigninState, scopeSlotTail, familyRouteWords, familyAbsentWords, type FamilySigninSummary, familySigninSummary, familySigninCount, type SigninCeilingRefusal, signinCeilingRefusal } from './account-slots/signin.js'
export { type MainLoopIdentityBasis, type MainLoopIdentity, type MainLoopIdentityInput, mainLoopIdentity } from './account-slots/mainLoopIdentity.js'
import { mistralSlots, nousSlots, zenSlots, minimaxSlots, togetherSlots, cohereSlots, groqSlots, meliousSlots, orcarouterSlots, cerebrasSlots, fireworksSlots, qwenSlots, deepseekSlots } from './account-slots/keyLane.js'
export { looksLikeProofFixtureKey } from './account-slots/keyLane.js'
import { anthropicSlots } from './account-slots/anthropic.js'
import { openaiSlots } from './account-slots/openai.js'
import { zaiSlots } from './account-slots/zai.js'
import { openrouterSlots } from './account-slots/openrouter.js'
export { openrouterSlots } from './account-slots/openrouter.js'
import { geminiSlots } from './account-slots/gemini.js'
import { moonshotSlots } from './account-slots/moonshot.js'
import { metaSlots } from './account-slots/meta.js'
import { xaiSlots } from './account-slots/xai.js'
import { compatSlots } from './account-slots/compat.js'
import { huggingfaceSlots } from './account-slots/huggingface.js'
import { localSlots } from './account-slots/local.js'
import { genericSlots } from './account-slots/generic.js'
export { type AnthropicSlotSignOutIo, signOutAnthropicSlot, credentialStoreLeftWords, executeSlotRemoval, familiesRefusedIn, signOutAccountFileNoSlotReads, signOutEveryEngineCredential } from './account-slots/removal.js'

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

