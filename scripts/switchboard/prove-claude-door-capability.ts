#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const text = (v: unknown): string => JSON.stringify(v) ?? ''

const scratch = mkdtempSync(join(tmpdir(), 'claude-door-capability-'))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'MERCURY_MODEL',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const UNKNOWN_CLAUDE_ID = 'claude-zephyr-9-1'
const STRANGER = 'zephyr-9-1'
const REAL_ID = 'claude-sonnet-5-5'

console.log('============================================================')
console.log(' the Claude door — a Claude id the account can run starts from every door; the wire decides')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const wm = await import('../../src/services/concourse/workerModels.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
const { getMainLoopModel } = await import('../../src/utils/model/model.ts')
const { refreshSignInReads } = await import('../../src/daemon/signInView.ts')

section(`§1 the session and crew doors: '${UNKNOWN_CLAUDE_ID}' (no catalogue knows it) dispatches on capability`)
{
  check('the id is inside the first-party space (the claude- mark routes it to the Anthropic lane)', declaredRouteOf(UNKNOWN_CLAUDE_ID) === 'anthropic', String(declaredRouteOf(UNKNOWN_CLAUDE_ID)))
  check('no catalogue row lists it', !getModelOptions().some(o => o.value === UNKNOWN_CLAUDE_ID))
  const session = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check('the SESSION door admits it — dispatched to the Anthropic lane, the wire decides', session.ok && session.entry.modelId === UNKNOWN_CLAUDE_ID && session.entry.session.availability === 'available', text(session))
  check('…with the ratified effort convention on the row', session.ok && session.entry.effort === 'high', text(session))
  const crew = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'crew')
  check('the CREW door admits it the same way (no door refuses what the account can run)', crew.ok && crew.entry.modelId === UNKNOWN_CLAUDE_ID, text(crew))
  const { resolveCrewSeatModel } = await import('../../src/daemon/crewSpawn.ts')
  const seat = await resolveCrewSeatModel(UNKNOWN_CLAUDE_ID)
  check("the crew seat resolver (the crew spawn's one door) seats it", seat.ok && seat.model === UNKNOWN_CLAUDE_ID, text(seat))
  const { preflightConcourseDispatch } = await import('../../src/daemon/concourseDispatch.ts')
  const preflight = await preflightConcourseDispatch({ workspaceDir: work, modelKey: UNKNOWN_CLAUDE_ID })
  check("the birth door's preflight (the boot face's New Session road) is CLEAN on it", preflight.ok === true, text(preflight))
  const twin = await wm.validateWorkerModelChoice(`${UNKNOWN_CLAUDE_ID}[1m]`, 'session')
  check('the [1m] rider folds and the bare id dispatches', twin.ok && twin.entry.modelId === UNKNOWN_CLAUDE_ID, text(twin))
}

section('§2 the honest refusals stay: a family-less stranger, and a keyless family')
{
  const stranger = await wm.validateWorkerModelChoice(STRANGER, 'session')
  check(`'${STRANGER}' (no family declares it) still refuses not-runnable:unrecognised`, !stranger.ok && stranger.reason === 'not-runnable:unrecognised' && /no provider family declares/.test(stranger.detail ?? ''), text(stranger))
  check("…and its action names the picker, never a family's door", !stranger.ok && /model picker/.test(stranger.action ?? ''), text(stranger))
  const spoken = await wm.validateWorkerModelChoice('sonnet 5', 'session')
  check("a spoken name still lands on its one row ('sonnet 5' → claude-sonnet-5)", spoken.ok && spoken.entry.modelId === 'claude-sonnet-5', text(spoken))
  const listed = await wm.validateWorkerModelChoice('claude-opus-5-5', 'session')
  check('a listed row keeps its display name (the catalogue still names what it knows)', listed.ok && listed.entry.displayName === 'Opus 5.5', text(listed))

  delete process.env.ANTHROPIC_API_KEY
  refreshSignInReads(true)
  const keyless = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check("with no Anthropic credential the id refuses no-credential:anthropic — the family's door, never 'unknown-model'", !keyless.ok && keyless.reason === 'no-credential:anthropic', text(keyless))
  check('…with the /logins anthropic action riding the refusal', !keyless.ok && /\/logins anthropic/.test(keyless.action ?? ''), text(keyless))
  process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
  refreshSignInReads(true)

  const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ availableModels: ['claude-opus-5-5'] }, null, 2))
  resetSettingsCache()
  const forbidden = await wm.validateWorkerModelChoice(UNKNOWN_CLAUDE_ID, 'session')
  check("an organization's availableModels still binds the door (the REPL refuses on it before any call)", !forbidden.ok && forbidden.reason === 'not-runnable:not-allowed' && /availableModels/.test(forbidden.detail ?? ''), text(forbidden))
  const forbiddenEngine = await wm.validateWorkerModelChoice('gpt-5.9-nova', 'session')
  check('…and binds an engine namespace id the same way', !forbiddenEngine.ok && forbiddenEngine.reason === 'not-runnable:not-allowed', text(forbiddenEngine))
  writeFileSync(join(home, 'settings.json'), JSON.stringify({}, null, 2))
  resetSettingsCache()
}

section(`§3 the real case: '${REAL_ID}' saved after the daemon booted, judged by a bundle whose catalogue predates the row`)
{
  const primed = getMainLoopModel()
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ model: REAL_ID }, null, 2))
  check("the saved setting names the row while this process's settings read still holds its boot-time value (the daemon's read)", getMainLoopModel() === primed && primed !== REAL_ID, `${primed} → ${getMainLoopModel()}`)
  const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
  const canonical = (value: string): string => parseUserSpecifiedModel(value).replace(/\[1m]$/, '')
  const preRow = () => getModelOptions().filter(o => canonical(o.value) !== REAL_ID)
  check('the pre-row catalogue read lists no Sonnet 5.5 row', !preRow().some(o => canonical(o.value) === REAL_ID))
  const registry = await wm.composeWorkerModelRegistry({ modelOptions: preRow })
  check("the registry composes from the injected read — a bundle whose catalogue predates the row (a build without the read judges by its own catalogue alone)", !registry.entries.some(e => e.modelId === REAL_ID), text(registry.entries.map(e => e.modelId)))
  const born = await wm.validateWorkerModelChoice(REAL_ID, 'session', { modelOptions: preRow })
  check(`the boot face's new session on '${REAL_ID}' resolves under that read — dispatched to the Anthropic lane, never "'${REAL_ID}' is not an exact model id"`, born.ok && born.entry.modelId === REAL_ID && born.entry.session.availability === 'available', text(born))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ prove-claude-door-capability — all checks pass' : `\n❌ prove-claude-door-capability — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
