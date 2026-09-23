process.env.NODE_ENV = 'test'
process.env.FORCE_COLOR = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
export const { buildFacts } = await import('../../src/commands/status/mercuryStatus.js')
const { getDefaultMainLoopModel } = await import('../../src/utils/model/model.js')
export const model = getDefaultMainLoopModel()
type Reads = NonNullable<Parameters<typeof buildFacts>[2]>
const connector = {
  carrier: 'daemon',
  sessionId: () => 'fixture',
  modelFacts: () => ({ effective: model, effortSent: 'max', effectiveSource: 'live' }),
  permissionMode: () => 'sovereign',
  checkpointFacts: () => ({ capture: 'on', restorable: new Set() }),
  workRoster: () => ({ rows: [], mission: [], reported: true }),
  mcpRoster: () => ({ clients: [{ name: 'one' }, { name: 'two' }] }),
  skillsRoster: () => ({ skills: [{ name: 'one' }, { name: 'two' }, { name: 'three' }] }),
}
export const fixtureReads = {
  artifact: () => ({ version: '1.0.0-beta.18', buildTree: '052293d7' }),
  model: () => ({ state: 'live', data: { name: 'Fable 5.1', window: 1_000_000 } }),
  context: () => ({ state: 'live', data: { usedPct: 12, window: 1_000_000, fillSource: 'wire', windowSource: 'catalogue' } }),
  connector: () => connector,
  telemetry: () => ({ sessions: { state: 'known', rows: [{ sessionId: 'fixture', live: true, paused: false, parked: false, stopped: false }] }, trace: { state: 'live', data: { total: 17274 } }, workflowsDisk: [] }),
  seats: () => ({ seats: 17 }),
  settings: () => ({ shellEngine: 'system' }),
  shell: () => ({ engine: 'system' }),
  families: () => [
    { id: 'anthropic', credentialed: true, credentialLabel: 'Claude subscription (max)' },
    { id: 'openai', credentialed: true, credentialLabel: 'ChatGPT pro subscription' },
    ...[['zai', 'Z.AI'], ['moonshot', 'Moonshot'], ['deepseek', 'DeepSeek']].map(([id, name]) => ({ id, credentialed: true, credentialLabel: `${name} API key (stored, auth-scoped)` })),
    { id: 'openrouter', credentialed: true, credentialLabel: 'OpenRouter (OAuth-minted key)' },
    { id: 'gemini', credentialed: true, credentialLabel: 'Google account (OAuth)' },
    { id: 'huggingface', credentialed: true, identity: 'op-hf', credentialLabel: 'Hugging Face account (op-hf)' },
    { id: 'openai-compat', credentialed: false },
    { id: 'local', credentialed: false },
  ],
  accountUsage: (id: string) => ({
    windows: id === 'anthropic' ? [{ key: '5h', state: 'live', usedPct: 52 }, { key: '7d', state: 'live', usedPct: 49 }] : [],
    ...(id === 'openai' ? { limited: { resetsAtMs: new Date(2030, 8, 30).getTime() } } : {}),
  }),
  health: () => ({ state: 'unavailable', reason: 'no certificate issued — run /health', data: { verdict: null } }),
  mcp: () => ({ state: 'off', data: { counts: { total: 0 } } }),
  tasks: () => ({}),
  daemon: () => 'running',
} as unknown as Reads
export const fixture = buildFacts([], model, fixtureReads)
