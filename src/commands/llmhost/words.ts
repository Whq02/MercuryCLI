export const LLM_HOST_WORDS = {
  command: '/llmhost',
  description: 'Rent a GPU, use SSH, or connect a running model server',
  where: 'Where should the model run?',
  rent: 'Rent a GPU (Runpod)',
  ssh: 'A box I can reach by SSH',
  existing: 'A server that’s already running',
  paid: 'Pods I’m paying for',
  runpodKey: 'Runpod API key',
  runpodKeyHelp: 'Runpod console → Settings → API Keys. Paste a key with Pods and Catalog access.',
  runpodKeySave: 'Save in the credential store used by /logins; never in settings or a URL.',
  offers: 'Choose a model · live Runpod stock',
  shapes: 'Choose a GPU shape · live Runpod stock',
  budget: 'Optional spending budget in USD',
  budgetHelp: 'Runpod does not expose account credit here. Enter a budget for an hours estimate, or leave blank.',
  rentalConfirm: 'Confirm the hourly price',
  watchConfirm: 'Watch for stock and rent at this price or less',
  rentalStorage: 'Storage is extra, including while stopped. Terminate deletes the pod and its volume disk.',
  creating: 'Creating the pod',
  publicKey: 'Preparing the SSH key',
  podWait: 'Waiting for the pod and its SSH port',
  engine: 'Downloading weights and starting the engine',
  health: 'Waiting for /health and /v1/models',
  tunnel: 'Opening the private SSH tunnel',
  manage: 'Pod controls',
  stopPod: 'Stop · keep the disk (storage still bills)',
  terminatePod: 'Terminate · delete the pod and its disk',
  keepPod: 'Keep running and close',
  closePod: 'Close · keep the stopped disk',
  stoppedDisk: 'Stopped · compute ended; disk storage still bills until Terminate.',
  terminatedPod: 'Pod terminated · its volume disk is deleted.',
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
  keyRun: 'Keep the key in memory for this check; registration uses the compat login store, never settings.',
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
  unchanged: 'Nothing was changed.',
  inputError: 'That value is not valid. Try again.',
  replyPrompt: 'Reply with the single word ready.',
  replySystem: 'This is a connection check. Give one short reply.',
  ready: 'ready',
  failed: 'reply check failed',
  empty: 'The server completed without a text reply.',
  finished: 'esc closes',
  offersHelp: 'Live stock and prices on Secure Cloud, cheapest first. A price covers every GPU in the shape; storage is billed on top.',
  podKept: 'Closing keeps the pod · /llmhost → Pods I’m paying for → Stop or Terminate',
  ended: 'model server set-up · ended',
  stoppedSaved: 'stopped · provider saved · esc closes',
} as const

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

export function hostSetupEstimate(recipe: { engine?: string; pythonInstall?: string; diskGb: number; weightsGb?: number }): string {
  const buildMinutes = recipe.engine === 'llamacpp' || recipe.pythonInstall ? 10 : 5
  const engine = recipe.engine === 'llamacpp' ? 'builds llama.cpp' : recipe.pythonInstall ? 'installs SGLang' : 'starts the engine'
  const size = recipe.weightsGb
  if (size === undefined || !Number.isFinite(size) || size <= 0) return `${engine} ~${buildMinutes} min · downloads weights (size unknown) · loads model (time unknown). Total depends on the download; ${recipe.diskGb} GB is disk space, not download size`
  const downloadMinutes = Math.max(5, Math.ceil(size / 10 / 5) * 5)
  const loadMinutes = Math.max(1, Math.ceil(size / 70))
  const total = Math.ceil((buildMinutes + downloadMinutes + loadMinutes) / 5) * 5
  return `${engine} ~${buildMinutes} min · downloads ${size} GB ~${downloadMinutes} min · loads ~${loadMinutes} min · ~${total} min total (estimate at ~10 GB/min; stock and network can add time)`
}

export function hostPaidPodWords(pod: { id: string; name: string; status: string; cost: number; startedAt?: string | null; createdAt: string }, record?: { step?: string; startedAt: string }, now = Date.now()): string {
  if (pod.status === 'EXITED') return `${pod.name} · ${pod.id} · stopped · storage still bills`
  const started = Date.parse(record?.startedAt ?? pod.startedAt ?? pod.createdAt)
  const hours = Number.isFinite(started) ? Math.max(0, now - started) / 3600_000 : undefined
  const cost = hours === undefined ? 'elapsed time and cost unknown' : `${Math.floor(hours * 60)} min · $${(pod.cost * hours).toFixed(2)} so far (estimate; storage extra)`
  return `${pod.name} · ${pod.id} · ${record?.step ?? pod.status.toLowerCase()} · $${pod.cost.toFixed(2)}/hr · ${cost}`
}

export function hostReadyWords(label: string, model: string, record: { price: number; startedAt: string }): string {
  const [, provider, ...wire] = model.split('/')
  const hours = Math.max(0, Date.now() - Date.parse(record.startedAt)) / 3600_000
  return `${label} is ready. In /model, choose ${wire.join('/')} under Custom endpoint · ${provider}.\nOr run /model ${model}.\n$${(record.price * hours).toFixed(2)} so far (estimate; storage extra).`
}
