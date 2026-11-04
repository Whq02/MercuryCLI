import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { getActiveMission } from '../../guards/mission.js'
import { actionAffordance } from '../../keybindings/atlas.js'
import { loadKeybindingsSync } from '../../keybindings/loadUserBindings.js'
import { getNewlineInstructions } from '../../components/PromptInput/utils.js'
import { hostRecords } from '../host/store.js'
import { isLocalModelId, localRecordFor } from '../providers/local/localCatalogue.js'
import { getCachedLocalDiscovery } from '../providers/local/localDiscovery.js'
import { readHelperModelSetting } from '../providers/local/tensorfoldHelper.js'
import { pairableTensorFoldHosts } from '../providers/local/tensorfoldHosts.js'
import { readTensorFoldState, tensorFoldPresent, type TensorFoldState } from '../providers/local/tensorfoldState.js'
import { configuredCompatEndpoints } from '../providers/openaicompat/compatAccounts.js'
import { getEngineModel } from '../../utils/model/model.js'
import { getPlatform } from '../../utils/platform.js'
import { getInitialSettings, getSettingsForSource } from '../../utils/settings/settings.js'
import type { Tip, TipContext } from './types.js'
import { getSessionsSinceLastShown } from './tipHistory.js'


function boundChatChord(action: string, fallback: string): string | null {
  try {
    const affordance = actionAffordance(action, 'Chat', loadKeybindingsSync())
    if (affordance.kind === 'bound') return affordance.chord
    return null
  } catch {
    return fallback
  }
}

function currentModel(context?: TipContext): string {
  if (context?.model !== undefined) return context.model
  try {
    return getEngineModel()
  } catch {
    return ''
  }
}

function isLocalModelActive(context?: TipContext): boolean {
  return isLocalModelId(currentModel(context))
}

function localServerCount(context?: TipContext): number {
  if (context?.localServersCount !== undefined) return context.localServersCount
  return getCachedLocalDiscovery()?.servers.length ?? 0
}

function isLlmHostActiveOrConfigured(context?: TipContext): boolean {
  if (context?.llmHostConfigured !== undefined) return context.llmHostConfigured
  try {
    if (configuredCompatEndpoints().length > 0) return true
    return hostRecords().length > 0
  } catch {
    return false
  }
}

const TENSORFOLD_STATE_TTL_MS = 60_000
let tensorFoldStateRead: { at: number; state: Promise<TensorFoldState> } | undefined

function tensorFoldStateForTips(): Promise<TensorFoldState> {
  const now = Date.now()
  if (tensorFoldStateRead === undefined || now - tensorFoldStateRead.at > TENSORFOLD_STATE_TTL_MS) {
    tensorFoldStateRead = { at: now, state: readTensorFoldState().catch(() => ({ engine: undefined, servers: [], app: { running: false }, helper: { enabled: false } })) }
  }
  return tensorFoldStateRead.state
}

function isTensorFoldServing(context?: TipContext): boolean {
  if (context?.tensorfold?.serving !== undefined) return context.tensorfold.serving
  const model = currentModel(context)
  const record = localRecordFor(model)
  if (record?.server === 'tensorfold') return true
  const servers = getCachedLocalDiscovery()?.servers ?? []
  return servers.some(server => server.kind === 'tensorfold' && server.models.length > 0)
}

async function isTensorFoldInstalledOrServing(context?: TipContext): Promise<boolean> {
  if (context?.tensorfold !== undefined) return context.tensorfold.installed === true || isTensorFoldServing(context)
  if (isTensorFoldServing(context)) return true
  return tensorFoldPresent(await tensorFoldStateForTips())
}

async function isTensorFoldServingOrPaired(context?: TipContext): Promise<boolean> {
  if (context?.tensorfold !== undefined) return isTensorFoldServing(context) || context.tensorfold.pairedHost === true
  if (isTensorFoldServing(context)) return true
  try {
    if (pairableTensorFoldHosts().length > 0) return true
  } catch {
    void 0
  }
  return (await tensorFoldStateForTips()).servers.length > 0
}

function isHelperModelEnabled(context?: TipContext): boolean {
  if (context?.tensorfold?.helperEnabled !== undefined) return context.tensorfold.helperEnabled
  try {
    return readHelperModelSetting().size !== 'off'
  } catch {
    return false
  }
}


const GENERAL_TIPS: Tip[] = [
  {
    id: 'cycle-mode',
    cooldownSessions: 5,
    async content() {
      const chord = boundChatChord('chat:cycleMode', 'shift+tab') ?? 'shift+tab'
      return `Press ${chord} to cycle default, implement, apollo, flow, and sovereign in this session.`
    },
    async isRelevant() {
      return boundChatChord('chat:cycleMode', 'shift+tab') !== null
    },
  },
  {
    id: 'help-browse',
    cooldownSessions: 8,
    async content() {
      return '/help lists every active command and the keybindings bound in this terminal.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'sessions-switch',
    cooldownSessions: 8,
    async content() {
      return '/sessions switches or reopens a session in place — the one you leave keeps working.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'concourse-board',
    cooldownSessions: 8,
    async content() {
      return '/concourse opens the two-pane board — live view left, session list right, n for a new chat.'
    },
    async isRelevant() {
      return !chatOnlyBoot()
    },
  },
  {
    id: 'goal-end-state',
    cooldownSessions: 10,
    async content() {
      return "/goal <end state> checks each turn's evidence until the goal is met or needs your word."
    },
    async isRelevant() {
      return getActiveMission() === undefined
    },
  },
  {
    id: 'compact-fold',
    cooldownSessions: 10,
    async content() {
      return '/compact <instructions> steers the summary while keeping your own messages word for word.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'effort',
    cooldownSessions: 10,
    async content() {
      return '/effort applies to this session now and saves the default effort for new sessions.'
    },
    async isRelevant() {
      return getSettingsForSource('policySettings')?.engine?.effort === undefined
    },
  },
  {
    id: 'multi-family',
    cooldownSessions: 8,
    async content() {
      return 'Sign into more providers with /logins — /model then switches the family mid-session.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'apollo-interview',
    cooldownSessions: 12,
    async content() {
      return 'Apollo mode writes the spec files first; its closing review asks before the prototype build.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'newline-terminal',
    cooldownSessions: 15,
    async content() {
      return `Multi-line prompt: ${getNewlineInstructions()}.`
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'rewind-checkpoint',
    cooldownSessions: 12,
    async content() {
      return '/rewind winds back code, conversation, or both — pick the saved point to return to.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'diff-review',
    cooldownSessions: 15,
    async content() {
      return '/diff reviews uncommitted and per-turn changes by source, file, and hunk.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'pr-review',
    cooldownSessions: 15,
    async content() {
      return '/review has Mercury review a pull request — bare, it picks from the open ones.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'workflows-board',
    cooldownSessions: 20,
    async content() {
      return 'Workflows are scripted multi-step crewmate runs — /workflows boards the active and the past.'
    },
    async isRelevant() {
      return !chatOnlyBoot()
    },
  },
  {
    id: 'swarm-crew-chat',
    cooldownSessions: 12,
    async content() {
      return '/swarm opens Crew chat; /swarm on shares the board with new crewmates.'
    },
    async isRelevant() {
      return getInitialSettings().swarm?.enabled !== false
    },
  },
  {
    id: 'swarmchat-channel',
    cooldownSessions: 12,
    async content() {
      return '/swarmchat shows board posts in the chat — all, one team, or only those that name main.'
    },
    async isRelevant() {
      return getInitialSettings().swarm?.enabled !== false
    },
  },
  {
    id: 'team-post',
    cooldownSessions: 15,
    async content() {
      return '/team <name> <text> posts to one team on the board.'
    },
    async isRelevant() {
      return getInitialSettings().swarm?.enabled !== false
    },
  },
  {
    id: 'whisper-post',
    cooldownSessions: 15,
    async content() {
      return '/whisper <name> <text> addresses one crewmate on the shared board.'
    },
    async isRelevant() {
      return getInitialSettings().swarm?.enabled !== false
    },
  },
  {
    id: 'general-post',
    cooldownSessions: 15,
    async content() {
      return '/general <text> posts to every crewmate on the board.'
    },
    async isRelevant() {
      return getInitialSettings().swarm?.enabled !== false
    },
  },
  {
    id: 'submodels-seats',
    cooldownSessions: 20,
    async content() {
      return "/submodels seats the Console's and the Advisor's models — side questions and advice."
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'usage-meters',
    cooldownSessions: 20,
    async content() {
      return '/usage shows provider windows, session spend, and honest absence where no meter exists.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'accounts-board',
    cooldownSessions: 20,
    async content() {
      return '/accounts boards every signed-in account by provider, with re-login per slot.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'caching-truth',
    cooldownSessions: 20,
    async content() {
      return "/caching shows every provider family's cache truth — and the TTL dial where one exists."
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'remember-card',
    cooldownSessions: 15,
    async content() {
      return 'Retain saves a fact for future sessions; /memory shows and corrects what Mercury keeps.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'localsetup-sources',
    cooldownSessions: 12,
    async content() {
      return '/localsetup pulls a Hugging Face GGUF into the Bank, or connects Ollama and llama-server.'
    },
    async isRelevant(context) {
      return !isLocalModelActive(context) && localServerCount(context) === 0
    },
  },
  {
    id: 'local-discovery-picker',
    cooldownSessions: 10,
    async content() {
      return '/model lists discovered Ollama, LM Studio, vLLM, and llama.cpp models as local/<name>.'
    },
    async isRelevant(context) {
      return localServerCount(context) > 0 && !isLocalModelActive(context)
    },
  },
  {
    id: 'local-window-fit',
    cooldownSessions: 12,
    async content() {
      return 'Local context windows size to usable memory (64k floor); /config sets Local model window.'
    },
    async isRelevant(context) {
      return isLocalModelActive(context) || localServerCount(context) > 0
    },
  },
  {
    id: 'local-prompt-cache',
    cooldownSessions: 15,
    async content() {
      return 'Local turns keep a stable tool prefix and llama.cpp slot so the server reuses its KV cache.'
    },
    async isRelevant(context) {
      return isLocalModelActive(context)
    },
  },
  {
    id: 'local-effort-wire',
    cooldownSessions: 12,
    async content() {
      return '/effort and opt+t send reasoning_effort to local servers that declare reasoning levels.'
    },
    async isRelevant(context) {
      return isLocalModelActive(context)
    },
  },
  {
    id: 'local-health-usage',
    cooldownSessions: 15,
    async content() {
      return '/usage shows local tok/s and cached tokens per turn; /health checks local server reach.'
    },
    async isRelevant(context) {
      return isLocalModelActive(context) || localServerCount(context) > 0
    },
  },
  {
    id: 'llmhost-pod-billing',
    cooldownSessions: 12,
    async content() {
      return 'In /llmhost, stopping a rented pod ends compute billing, but its disk bills until Terminate.'
    },
    async isRelevant(context) {
      return isLlmHostActiveOrConfigured(context)
    },
  },
  {
    id: 'llmhost-register-model',
    cooldownSessions: 15,
    async content() {
      return '/llmhost rents a GPU or connects an SSH or running server; /model switches to the new slot.'
    },
    async isRelevant(context) {
      return isLlmHostActiveOrConfigured(context) || isLocalModelActive(context)
    },
  },
  {
    id: 'tensorfold-picker-groups',
    cooldownSessions: 10,
    async content() {
      return '/model pins TENSORFOLD and TENSORFOLD HOST first; /tensorfold opens the control panel.'
    },
    async isRelevant(context) {
      return (await isTensorFoldInstalledOrServing(context)) || isTensorFoldServingOrPaired(context)
    },
  },
  {
    id: 'tensorfold-enter-serve',
    cooldownSessions: 10,
    async content() {
      return 'In /tensorfold, ↵ pulls, serves, and switches in one step; s stops what Mercury started.'
    },
    async isRelevant(context) {
      return isTensorFoldInstalledOrServing(context)
    },
  },
  {
    id: 'tensorfold-window-arrows',
    cooldownSessions: 12,
    async content() {
      return 'On a TensorFold row, ←→ steps the 32k to 256k window; ↵ on a served row restarts it there.'
    },
    async isRelevant(context) {
      return isTensorFoldInstalledOrServing(context)
    },
  },
  {
    id: 'tensorfold-lan-pair',
    cooldownSessions: 15,
    async content() {
      return 'TENSORFOLD HOST lists Macs serving TensorFold on your LAN and pairs with a one-time code.'
    },
    async isRelevant(context) {
      return isTensorFoldServingOrPaired(context)
    },
  },
  {
    id: 'tensorfold-helper-model',
    cooldownSessions: 15,
    async content() {
      return 'Helper model in /config (off by default) uses a local 2B or 4B for titles and goal checks.'
    },
    async isRelevant(context) {
      return (await isTensorFoldInstalledOrServing(context)) && !isHelperModelEnabled(context)
    },
  },
  {
    id: 'tensorfold-effort-cache',
    cooldownSessions: 12,
    async content() {
      return 'On TensorFold, /effort sets reasoning_effort and thinking budget; opt+t off sends none.'
    },
    async isRelevant(context) {
      return isTensorFoldServing(context)
    },
  },
  {
    id: 'mouse-toggle',
    cooldownSessions: 30,
    async content() {
      return "/mouse toggles mouse capture — off keeps the terminal's native select and copy."
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'appearance-command',
    cooldownSessions: 25,
    async content() {
      return '/appearance holds the look — theme, accent, and motion in one place.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'skills-location',
    cooldownSessions: 30,
    async content() {
      return 'Skills load on their own from .mercury/skills/ or ~/.mercury/skills/ — drop one in.'
    },
    async isRelevant() {
      return true
    },
  },
  {
    id: 'powershell-tool',
    cooldownSessions: 20,
    async content() {
      return 'Set MERCURY_USE_POWERSHELL_TOOL=1 to run Windows commands through PowerShell.'
    },
    async isRelevant() {
      if (getPlatform() !== 'windows') return false
      return process.env.MERCURY_USE_POWERSHELL_TOOL === undefined
    },
  },
]

const INTERNAL_TIPS: Tip[] = []

const CATALOGUE: Tip[] = [...GENERAL_TIPS, ...INTERNAL_TIPS]


function getCustomTips(): { tips: Tip[]; excludeDefault: boolean } {
  const override = getInitialSettings().activity?.tips?.words as
    | { tips?: unknown; excludeDefault?: unknown }
    | undefined
  const rawTips = Array.isArray(override?.tips) ? (override?.tips as unknown[]) : []
  const strings = rawTips.filter((entry): entry is string => typeof entry === 'string')
  const tips: Tip[] = strings.map((text, index) => ({
    id: `custom-${index}`,
    cooldownSessions: 0,
    content: async () => text,
    isRelevant: async () => true,
  }))
  return { tips, excludeDefault: override?.excludeDefault === true }
}


export async function getRelevantTips(context?: TipContext): Promise<Tip[]> {
  const { tips: customTips, excludeDefault } = getCustomTips()
  if (excludeDefault && customTips.length > 0) {
    return customTips
  }

  const verdicts = await Promise.all(CATALOGUE.map(tip => tip.isRelevant(context)))
  const relevant = CATALOGUE.filter((tip, index) => verdicts[index])
  const afterCooldown = relevant.filter(
    tip => getSessionsSinceLastShown(tip.id) >= tip.cooldownSessions,
  )
  return [...afterCooldown, ...customTips]
}
