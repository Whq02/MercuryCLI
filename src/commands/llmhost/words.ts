import { configuredCompatEndpoints } from '../../services/providers/openaicompat/compatAccounts.js'
import { compatPrefixCacheWords } from '../../services/providers/openaicompat/compatPrefixCache.js'
import { HOST_VENDOR_INFO } from '../../services/host/vendors/vendor.js'

export const LLM_HOST_WORDS = {
  description: 'Rent a GPU, use SSH, or connect a running model server',
  where: 'Where should the model run?',
  rent: 'Rent a GPU (' + Object.values(HOST_VENDOR_INFO).map(info => info.label).join(', ') + ')',
  ssh: 'A box I can reach by SSH',
  existing: 'A server that’s already running',
  paid: 'Machines I’m paying for',
  offers: 'Choose a model · live Runpod stock',
  shapes: 'Choose a GPU shape · live Runpod stock',
  budget: 'Optional spending budget in USD',
  budgetHelp: 'Runpod does not expose account credit here. Enter a budget for an hours estimate, or leave blank.',
  rentalConfirm: 'Confirm the hourly price',
  watchConfirm: 'Watch for stock and rent at this price or less',
  creating: 'Creating the machine',
  publicKey: 'Preparing the SSH key',
  engine: 'Downloading weights and starting the engine',
  health: 'Waiting for /health and /v1/models',
  tunnel: 'Opening the private SSH tunnel',
  manage: 'Machine controls',
  stopPod: 'Stop · keep the disk (storage still bills)',
  terminatePod: 'Terminate · delete the machine and its disk',
  keepPod: 'Keep running and close',
  closePod: 'Close · keep the stopped disk',
  stoppedDisk: 'Stopped · compute ended; disk storage still bills until Terminate.',
  terminatedPod: 'Machine terminated · its disk is deleted.',
  noStock: 'No documented shape has stock right now. Choose a model to watch for stock, or refresh.',
  sshHost: 'SSH host or config alias',
  sshUser: 'SSH user (blank uses SSH config)',
  sshPort: 'SSH port (blank uses SSH config)',
  sshKey: 'Private key path (blank uses SSH config or agent)',
  sshBank: 'Local model bank folder (blank downloads from Hugging Face)',
  sshConfirm: 'Start this model on the SSH box',
  opening: 'model server set-up · rental setup continues in the background',
  hint: '↑↓ choose · ↵ continue · esc or click outside closes',
  choose: '↑↓ then ↵ · nothing is pre-chosen',
  suggested: '↑↓ then ↵ · the cursor starts on a suggestion',
  input: '↵ continue · esc closes',
  running: 'running… · esc closes',
  stopped: 'stopped · nothing more runs · esc closes',
  servers: 'registered servers',
  add: 'connect another server',
  action: 'what to do with this server',
  recheck: 'check a reply again',
  repoint: 'change the address and check it',
  remove: 'remove this provider and its stored key',
  address: '1 · the server address',
  addressFound: 'A server you already run, or the loopback address of an SSH tunnel.',
  addressRun: 'Read the model list and server metadata at this address. Nothing is installed or started.',
  dialect: '2 · the server dialect',
  dialectUnknown: 'The server did not identify its dialect. Choose the API it serves.',
  dialectRun: 'Use this dialect for model requests and read its served window.',
  key: '3 · the server key',
  keyRequired: 'The server asked for a key. It is hidden here and stored only when you register.',
  keyOptional: 'No key was needed to list models. Leave blank, or give a key for replies.',
  keyRun: 'Used for this check; saved only when you register.',
  model: '4 · choose the model',
  modelRun: 'Choose one listed model for the reply check. Every listed model will appear in /model.',
  name: '5 · name the provider',
  nameFound: 'Use 1–32 lowercase letters, digits or hyphens. The default is llmhost.',
  nameRun: 'The model will be named compat/<name>/<model>. An existing name is never overwritten by a new server.',
  confirm: '5 · register and check a reply',
  confirmRun: 'Save endpoint + key, then request one reply. The session model stays unchanged.',
  recheckRun: 'Read this server’s models and ask the selected model for one short reply. The session model stays unchanged.',
  register: 'register and check',
  check: 'check a reply',
  cancel: 'keep things as they are',
  done: '6 · provider registered',
  removed: 'provider removed · the server itself keeps running',
  noModels: 'The server returned no models. Load a model there, then open /llmhost again.',
  inputError: 'That value is not valid. Try again.',
  replyPrompt: 'Reply with the single word ready.',
  replySystem: 'This is a connection check. Give one short reply.',
  failed: 'reply check failed',
  empty: 'The server completed without a text reply.',
  finished: 'esc closes',
  offersHelp: 'Live stock and prices on Secure Cloud, cheapest first. A price covers every GPU in the shape; storage is billed on top.',
  ended: 'model server set-up · ended',
  stoppedSaved: 'stopped · provider saved · esc closes',
} as const

export const hostHuggingfaceScopeWords = (knownScope: boolean): string => knownScope
  ? 'Hugging Face: this sign-in lacks Inference Endpoints management (HTTP 403) · sign in again with /logins huggingface.'
  : 'Hugging Face: sign in again with /logins huggingface to grant Inference Endpoints management (HTTP 403).'

export const LLM_HOST_SEARCH_MIN_CHARS = 3
export const LLM_HOST_SEARCH_SETTLE_MS = 450

export const LLM_HOST_DIALECTS = [
  { value: 'sglang', label: 'SGLang' },
  { value: 'vllm', label: 'vLLM' },
  { value: 'llamacpp', label: 'llama.cpp' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'lmstudio', label: 'LM Studio' },
  { value: 'chat-completions', label: 'OpenAI-compatible chat completions' },
  { value: 'responses', label: 'OpenAI-compatible Responses' },
] as const

export function hostWindowWords(window: number | undefined): string {
  return window === undefined ? 'window not stated by server' : `${window.toLocaleString('en-US')} tokens · served window`
}

export function hostReplyWords(model: string, reply: string, elapsedMs: number, outputTokens?: number): string {
  const seconds = Math.max(0.001, elapsedMs / 1000)
  return `${model} · ${JSON.stringify(reply)} · ${seconds.toFixed(2)} s${outputTokens === undefined ? '' : ` · ${outputTokens} output tokens · ${(outputTokens / seconds).toFixed(1)} tokens/s (whole turn)`}`
}

function prebuiltEngineImage(engine: string | undefined, image: string | undefined): boolean {
  return engine === 'llamacpp' && /^ghcr\.io\/whq02\/mercury-llamacpp[:@]/.test(image ?? '')
}

export function hostSetupEstimate(recipe: { engine?: string; pythonInstall?: string; install?: string; image?: string; diskGb: number; weightsGb?: number }, kept?: { check: string }): string {
  const size = recipe.weightsGb
  const engineMinutes = prebuiltEngineImage(recipe.engine, recipe.image) ? 1 : recipe.engine === 'llamacpp' || recipe.pythonInstall ? 10 : 5
  const engine = engineMinutes === 1 ? 'Engine from image ~1 min · no engine build' : recipe.engine === 'llamacpp' ? 'builds llama.cpp ~10 min' : recipe.pythonInstall ? 'installs SGLang ~10 min' : 'starts the engine ~5 min'
  if (size === undefined || !Number.isFinite(size) || size <= 0) return `${engine} · downloads weights (size unknown) · loads model (time unknown). Total depends on the download; ${recipe.diskGb} GB is disk space, not download size`
  const fast = Math.max(5, Math.ceil(size / 60 / 5) * 5)
  const slow = Math.max(5, Math.ceil(size / 30 / 5) * 5)
  const loadMinutes = Math.max(3, Math.ceil(size / 70))
  const weights = kept ? `weights kept ~0 download · ${kept.check}` : `downloads ${+size.toFixed(2)} GB ~${fast === slow ? fast : fast + '–' + slow} min`
  const total = Math.ceil((engineMinutes + (kept ? 0 : slow) + loadMinutes) / 5) * 5
  return `${engine} · ${weights} · loads ~${loadMinutes} min · ~${total} min total (estimate at a sustained 0.5–1 GB/s; stock and network can add time)`
}

export const hostNoStockWords = (vendors: readonly string[]): string => 'no stock on ' + (vendors.length ? vendors.join(', ') : 'the connected vendors') + ' · watch →'

export const hostRunningCountWords = (running: number): string => running ? ' · ' + running + ' running' : ''

export const hostVendorKeysWords = (vendors: readonly { label: string; connected: boolean; fault?: 'key' | 'read' }[]): string =>
  'Vendor keys · ' + vendors.map(row => row.label + (row.fault === 'key' ? ' ✗ replace the key to reconnect' : row.fault === 'read' ? ' ✗ could not be read' : row.connected ? ' ✓' : '')).join(' · ') + ' — replace or remove →'

export const hostMachineName = (vendor: keyof typeof HOST_VENDOR_INFO, id: string): string => (vendor === 'huggingface' ? 'HF endpoint' : HOST_VENDOR_INFO[vendor].label + (vendor === 'runpod' ? ' pod' : ' instance')) + ' ' + id

export interface HostEngineDeathFacts { at: number; line: string; oom: boolean; contextTokens?: number; budgetTokens?: number; poolTokens?: number }

export const hostTokensWords = (n: number): string => n >= 1048576 ? (n % 1048576 === 0 ? String(n / 1048576) : (n / 1048576).toFixed(1).replace(/\.0$/, '')) + 'M' : Math.max(1, Math.round(n / 1024)) + 'k'

export function hostEngineOomWords(facts: Pick<HostEngineDeathFacts, 'contextTokens' | 'budgetTokens'>): string {
  const at = facts.contextTokens ? ' at ' + hostTokensWords(facts.contextTokens) + ' tokens of context' : ' after setup'
  const budget = facts.budgetTokens ? ' · the recipe’s budget was ' + hostTokensWords(facts.budgetTokens) : ''
  return 'the engine ran out of GPU memory' + at + budget + ' · Resume restarts it; a shorter conversation or the Tune screen’s smaller context fits'
}

export function hostEngineDeadChatWords(record: { id: string; vendor?: keyof typeof HOST_VENDOR_INFO; price: number; engineDeath: HostEngineDeathFacts }): string {
  const death = record.engineDeath
  const what = death.oom
    ? 'the engine ran out of GPU memory' + (death.contextTokens ? ' at ' + hostTokensWords(death.contextTokens) + ' tokens of context' : '') + (death.budgetTokens ? ' (the recipe’s budget was ' + hostTokensWords(death.budgetTokens) + ')' : '') + ': ' + death.line
    : 'the engine died after setup: ' + death.line
  return hostMachineName(record.vendor ?? 'runpod', record.id) + ' · ' + what + ' · the machine stays up and bills $' + record.price.toFixed(2) + '/hr · Resume in /llmhost restarts the engine' + (death.oom ? '; a shorter conversation or the Tune screen’s smaller context fits' : '')
}

export function hostPaidPodWords(pod: { id: string; name: string; status: string; cost: number; startedAt?: string | null; createdAt: string; vendor?: keyof typeof HOST_VENDOR_INFO }, record?: { step?: string; startedAt: string; provider?: string }, now = Date.now()): string {
  const identity = hostMachineName(pod.vendor ?? 'runpod', pod.id) + ' · ' + pod.name
  if (pod.status === 'EXITED') return `${identity} · stopped · storage still bills`
  const started = Date.parse(record?.startedAt ?? pod.startedAt ?? pod.createdAt)
  const hours = Number.isFinite(started) ? Math.max(0, now - started) / 3600_000 : undefined
  const cost = hours === undefined ? 'elapsed time and cost unknown' : `${Math.floor(hours * 60)} min · $${(pod.cost * hours).toFixed(2)} so far (estimate; storage extra)`
  let cache = ''
  try {
    const endpoint = record?.provider ? configuredCompatEndpoints().find(row => row.name === record.provider) : undefined
    if (endpoint && pod.status === 'RUNNING' && record?.step === 'ready') cache = compatPrefixCacheWords(endpoint, now)
  } catch {}
  return `${identity} · ${record?.step ?? pod.status.toLowerCase()} · $${pod.cost.toFixed(2)}/hr · ${cost}${cache ? ' · ' + cache : ''}`
}

export function hostReadyWords(label: string, model: string, record: { price: number; startedAt: string }): string {
  const [, provider, ...wire] = model.split('/')
  const hours = Math.max(0, Date.now() - Date.parse(record.startedAt)) / 3600_000
  return `${label} is ready. In /model, choose ${wire.join('/')} under Custom endpoint · ${provider}.\nOr run /model ${model}.\n$${(record.price * hours).toFixed(2)} so far (estimate; storage extra).`
}
