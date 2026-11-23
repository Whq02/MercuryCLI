import { resolveProviderUsability } from '../../../models/roads/providerUsability.js'
import { ANTHROPIC_MODEL_GROUP, anthropicNotSignedInReason, COMPAT_MODEL_GROUP, DEEPSEEK_MODEL_GROUP, XAI_MODEL_GROUP, META_MODEL_GROUP, MISTRAL_MODEL_GROUP, ZEN_MODEL_GROUP, MINIMAX_MODEL_GROUP, TOGETHER_MODEL_GROUP, COHERE_MODEL_GROUP, GROQ_MODEL_GROUP, ORCAROUTER_MODEL_GROUP, MELIOUS_MODEL_GROUP, CEREBRAS_MODEL_GROUP, FIREWORKS_MODEL_GROUP, QWEN_MODEL_GROUP, getGptSeatAvailability, MOONSHOT_MODEL_GROUP, OPENAI_MODEL_GROUP, ZAI_MODEL_GROUP } from '../../../models/catalogue/modelOptions.js'
import { OPENROUTER_MODEL_GROUP, getOpenrouterAvailability } from '../../../models/roads/openrouter/openrouterCatalogue.js'
import { NOUS_MODEL_GROUP, getNousAvailability } from '../../../models/roads/nous/nousCatalogue.js'
import { GEMINI_MODEL_GROUP, getGeminiAvailability } from '../../../models/roads/gemini/geminiCatalogue.js'
import type { AnthropicDoor } from '../../../models/roads/anthropic/anthropicCatalogue.js'
import { HUGGINGFACE_MODEL_GROUP, getHuggingfaceAvailability } from '../../../models/roads/huggingface/huggingfaceCatalogue.js'
import { LOCAL_MODEL_GROUP, localDiscoverySummary } from '../../../models/roads/local/localCatalogue.js'
import { TENSORFOLD_HOST_GROUP, TENSORFOLD_MODEL_GROUP } from '../../../screen/tensorfold/tensorfoldRows.js'
import { anthropicCredentialPresence, providerFamilyPresences } from '../../../models/roads/providerUsage.js'
import { deriveFamilySlotGroups, type AccountSlot } from '../../../models/roads/accountSlots.js'
import { providerDoorAccount } from '../../../models/roads/providerIdentityLine.js'
import { accountIdentityShown } from '../../../models/wallet/identityWords.js'
import { providerDisplayName } from '../../../models/roads/routeLaw.js'
import { catalogueEpoch } from '../../../models/roads/catalogueEpoch.js'
import { signInLedgerEpoch } from '../../../models/sign-in/account-ledger/signInLedger.js'
import { getSubscriptionType } from '../../../models/sign-in/credentials/auth.js'
import type { ProviderHeading } from '../../../models/facts/modelPickerGroups.js'
import { logError } from '../../../platform/logs/errorLog.js'

const MODEL_GROUP_FAMILIES: Record<string, string> = {
  [ANTHROPIC_MODEL_GROUP]: 'anthropic',
  [OPENAI_MODEL_GROUP]: 'openai',
  [OPENROUTER_MODEL_GROUP]: 'openrouter',
  [GEMINI_MODEL_GROUP]: 'gemini',
  [HUGGINGFACE_MODEL_GROUP]: 'huggingface',
  [ZAI_MODEL_GROUP]: 'zai',
  [MOONSHOT_MODEL_GROUP]: 'moonshot',
  [DEEPSEEK_MODEL_GROUP]: 'deepseek',
  [XAI_MODEL_GROUP]: 'xai',
  [META_MODEL_GROUP]: 'meta',
  [ZEN_MODEL_GROUP]: 'zen',
  [MINIMAX_MODEL_GROUP]: 'minimax',
  [TOGETHER_MODEL_GROUP]: 'together',
  [COHERE_MODEL_GROUP]: 'cohere',
  [GROQ_MODEL_GROUP]: 'groq',
  [MELIOUS_MODEL_GROUP]: 'melious',
  [ORCAROUTER_MODEL_GROUP]: 'orcarouter',
  [CEREBRAS_MODEL_GROUP]: 'cerebras',
  [FIREWORKS_MODEL_GROUP]: 'fireworks',
  [QWEN_MODEL_GROUP]: 'qwen',
  [COMPAT_MODEL_GROUP]: 'openai-compat',
  [MISTRAL_MODEL_GROUP]: 'mistral',
  [LOCAL_MODEL_GROUP]: 'local',
  [NOUS_MODEL_GROUP]: 'nous',
  [TENSORFOLD_MODEL_GROUP]: 'local',
  [TENSORFOLD_HOST_GROUP]: 'local',
}

export function familyOfModelGroup(group: string): string | undefined {
  return MODEL_GROUP_FAMILIES[group]
}

export function groupOfFamily(family: string): string | undefined {
  return Object.entries(MODEL_GROUP_FAMILIES).find(([, candidate]) => candidate === family)?.[0]
}

const capitalise = (word: string): string => (word === '' ? word : word[0]!.toUpperCase() + word.slice(1))

export function anthropicDoorLabel(door: AnthropicDoor): string {
  if (door === 'api-key') return 'API key'
  if (door === 'bearer') return 'bearer token'
  const plan = getSubscriptionType()
  return plan ? `Claude ${capitalise(plan)} login` : 'Claude login'
}

function doorLabelOfSlot(family: string, slot: AccountSlot): string {
  if (family === 'anthropic') return anthropicDoorLabel(slot.kind === 'api-key' ? 'api-key' : 'subscription')
  if (family === 'openai') {
    if (slot.kind !== 'subscription') return 'API key'
    const plan = slot.kindLabel.replace(/\s*subscription$/, '')
    return plan !== '' && plan !== slot.kindLabel ? `ChatGPT ${capitalise(plan)} login` : 'ChatGPT login'
  }
  if (family === 'openrouter') return slot.kindLabel === 'OAuth-minted key' ? 'OAuth key' : 'API key'
  if (family === 'gemini') return slot.kind === 'oauth' ? 'Google account' : slot.kind === 'subscription' ? 'Google sign-in' : 'API key'
  if (family === 'moonshot') return slot.kind === 'oauth' ? 'Kimi login' : 'API key'
  if (family === 'huggingface') return 'token'
  return slot.kindLabel.replace(/ · (env|helper)$/, '')
}

function signedInDoorsOf(family: string, slots: readonly AccountSlot[], identity?: string): ProviderHeading['doors'] {
  const signedIn = slots.filter(slot => slot.signedIn)
  const ordered = [...signedIn.filter(slot => slot.active), ...signedIn.filter(slot => !slot.active)]
  const doors: ProviderHeading['doors'] = []
  for (const slot of ordered) {
    const door = doorLabelOfSlot(family, slot)
    if (doors.some(candidate => candidate.door === door)) continue
    const account = providerDoorAccount(slot, identity)
    doors.push({ door, ...(account !== undefined ? { account } : {}), ...(slot.active ? { active: true } : {}) })
  }
  return doors
}

let headingsMemo: { key: string; at: number; value: Record<string, ProviderHeading> } | null = null

export function providerHeadingsOf(slotVersion: number): Record<string, ProviderHeading> {
  const key = `${catalogueEpoch()}|${signInLedgerEpoch()}|${slotVersion}|${accountIdentityShown()}`
  const now = Date.now()
  if (headingsMemo !== null && headingsMemo.key === key && now - headingsMemo.at < 2_000) return headingsMemo.value
  const value = buildProviderHeadings()
  headingsMemo = { key, at: now, value }
  return value
}

function buildProviderHeadings(): Record<string, ProviderHeading> {
  let slotGroups: ReturnType<typeof deriveFamilySlotGroups> | null = null
  let slotFailureReason: string | undefined
  try {
    slotGroups = deriveFamilySlotGroups()
  } catch (error) {
    logError(error)
    slotFailureReason = `account status could not be read (${error instanceof Error ? error.message : String(error)}) — run /logins to check`
  }
  const slotsOf = (family: string): AccountSlot[] =>
    slotGroups?.find(group => group.family.id === family)?.slots ?? []
  const nameOf = (family: string): string => providerDisplayName(family).toUpperCase()
  const presences = new Map<string, { credentialed: boolean; identity?: string }>()
  try {
    for (const presence of providerFamilyPresences()) presences.set(presence.id, presence)
  } catch {
    presences.clear()
  }
  const doorsOf = (family: string): ProviderHeading['doors'] => (presences.has(family) && presences.get(family)!.credentialed === false ? [] : signedInDoorsOf(family, slotsOf(family), presences.get(family)?.identity))
  const gptAvailability = getGptSeatAvailability()
  const usability = resolveProviderUsability()
  const keyLaneHeading = (family: 'zai' | 'moonshot' | 'deepseek' | 'xai' | 'meta' | 'mistral' | 'zen' | 'minimax' | 'together' | 'cohere' | 'groq' | 'orcarouter' | 'melious' | 'cerebras' | 'fireworks' | 'qwen'): ProviderHeading => {
    const lane = usability[family]
    const doors = doorsOf(family)
    if (lane.credential === 'none') return { name: nameOf(family), doors: [], reason: lane.blockers[0] ?? 'not connected' }
    if (doors.length === 0) return { name: nameOf(family), doors: [], reason: slotFailureReason ?? lane.blockers[0] ?? 'not connected' }
    return { name: nameOf(family), doors }
  }
  const anthropicPresence = anthropicCredentialPresence()
  const anthropic: ProviderHeading = anthropicPresence.credentialed
    ? {
        name: nameOf('anthropic'),
        doors: signedInDoorsOf('anthropic', slotsOf('anthropic'), anthropicPresence.identity),
        ...(anthropicPresence.expired ? { reason: 'sign-in expired — /logins reconnects' } : slotFailureReason !== undefined ? { reason: slotFailureReason } : {}),
      }
    : { name: nameOf('anthropic'), doors: [], reason: anthropicNotSignedInReason() }
  const openrouterAvailability = getOpenrouterAvailability()
  const geminiAvailability = getGeminiAvailability()
  const huggingfaceAvailability = getHuggingfaceAvailability()
  const nousAvailability = getNousAvailability()
  const local = localDiscoverySummary()
  const compatDoors = doorsOf('openai-compat')
  const readyHeading = (family: string): ProviderHeading => ({
    name: nameOf(family),
    doors: doorsOf(family),
    ...(slotFailureReason !== undefined ? { reason: slotFailureReason } : {}),
  })
  return {
    [ANTHROPIC_MODEL_GROUP]: anthropic,
    [OPENAI_MODEL_GROUP]:
      gptAvailability.state === 'ready'
        ? readyHeading('openai')
        : { name: nameOf('openai'), doors: [], reason: gptAvailability.reason },
    [ZAI_MODEL_GROUP]: keyLaneHeading('zai'),
    [MOONSHOT_MODEL_GROUP]: keyLaneHeading('moonshot'),
    [DEEPSEEK_MODEL_GROUP]: keyLaneHeading('deepseek'),
    [XAI_MODEL_GROUP]: keyLaneHeading('xai'),
    [META_MODEL_GROUP]: keyLaneHeading('meta'),
    [MISTRAL_MODEL_GROUP]: keyLaneHeading('mistral'),
    [ZEN_MODEL_GROUP]: keyLaneHeading('zen'),
    [MINIMAX_MODEL_GROUP]: keyLaneHeading('minimax'),
    [TOGETHER_MODEL_GROUP]: keyLaneHeading('together'),
    [COHERE_MODEL_GROUP]: keyLaneHeading('cohere'),
    [GROQ_MODEL_GROUP]: keyLaneHeading('groq'),
    [MELIOUS_MODEL_GROUP]: keyLaneHeading('melious'),
    [ORCAROUTER_MODEL_GROUP]: keyLaneHeading('orcarouter'),
    [CEREBRAS_MODEL_GROUP]: keyLaneHeading('cerebras'),
    [FIREWORKS_MODEL_GROUP]: keyLaneHeading('fireworks'),
    [QWEN_MODEL_GROUP]: keyLaneHeading('qwen'),
    [OPENROUTER_MODEL_GROUP]:
      openrouterAvailability.state === 'ready'
        ? readyHeading('openrouter')
        : { name: nameOf('openrouter'), doors: [], reason: openrouterAvailability.reason },
    [GEMINI_MODEL_GROUP]:
      geminiAvailability.state === 'ready'
        ? readyHeading('gemini')
        : { name: nameOf('gemini'), doors: [], reason: geminiAvailability.reason },
    [HUGGINGFACE_MODEL_GROUP]:
      huggingfaceAvailability.state === 'ready'
        ? readyHeading('huggingface')
        : { name: nameOf('huggingface'), doors: [], reason: huggingfaceAvailability.reason },
    [COMPAT_MODEL_GROUP]: { name: nameOf('openai-compat'), doors: compatDoors, ...(slotFailureReason !== undefined ? { reason: slotFailureReason } : {}) },
    [LOCAL_MODEL_GROUP]:
      local.servers > 0
        ? { name: nameOf('local'), doors: [{ door: local.labels.join(' · ') }] }
        : { name: nameOf('local'), doors: [], reason: 'no local server answered' },
    [NOUS_MODEL_GROUP]:
      nousAvailability.state === 'ready'
        ? readyHeading('nous')
        : { name: nameOf('nous'), doors: [], reason: nousAvailability.reason },
  }
}
