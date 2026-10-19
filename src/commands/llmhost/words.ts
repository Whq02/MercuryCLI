export const LLM_HOST_WORDS = {
  command: '/llmhost',
  description: 'Connect a model server you already run: address, dialect, key, model, reply check and provider registration',
  opening: 'model server set-up · each step says what it will do and waits for ↵',
  hint: '↑↓ choose · ↵ continue · esc stop · click outside closes',
  choose: '↑↓ then ↵ · nothing is pre-chosen',
  input: '↵ continue · esc stop',
  running: 'running… · esc stops',
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
