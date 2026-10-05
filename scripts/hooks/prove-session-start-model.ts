#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'start-model-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'start-model-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.MERCURY_MODEL

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const SETTINGS = join(HOME, 'settings.json')
const CAPTURE = join(PROJ, 'session-start-input.json')
const posix = (p: string): string => p.replace(/\\/g, '/')
const writeSettings = (engine?: Record<string, unknown>): void =>
  writeFileSync(
    SETTINGS,
    JSON.stringify({
      ...(engine ? { engine } : {}),
      events: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `cat > "${posix(CAPTURE)}"` }] }] } },
    }),
  )

const state = await import('../../src/bootstrap/state.js')
const { setCwd } = await import('../../src/utils/Shell.js')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.js')
const { captureHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.js')
const { processSessionStartHooks } = await import('../../src/utils/sessionStart.js')
const { getEngineModel } = await import('../../src/utils/model/model.js')
const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.js')
const { loadInitialMessages } = await import('../../src/cli/headless/resume.js')
const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.js')

setCwd(PROJ)
state.setOriginalCwd(PROJ)
state.setProjectRoot(PROJ)
state.setIsInteractive(false)
state.setSessionTrustAccepted(true)

type HookInput = Record<string, unknown>
const fire = async (drive: () => Promise<unknown>): Promise<HookInput | null> => {
  rmSync(CAPTURE, { force: true })
  resetSettingsCache()
  captureHooksConfigSnapshot()
  await drive()
  return existsSync(CAPTURE) ? (JSON.parse(readFileSync(CAPTURE, 'utf8')) as HookInput) : null
}
const keysWithout = (input: HookInput | null, key: string): string =>
  Object.keys(input ?? {})
    .filter(name => name !== key)
    .sort()
    .join(',')
const BASE_KEYS = 'cwd,hook_event_name,session_id,source,transcript_path'
const noop = (): void => {}

const FLAG = 'claude-sonnet-5-5'
const PIN = 'claude-sonnet-4-6'
const RECORDED = 'claude-opus-4-8'
const CALLER = 'claude-haiku-4-5-20251001'

section('§1 A STARTUP ON --model: THE HOOK INPUT NAMES THE SESSION MODEL')
{
  writeSettings()
  state.setEngineModelOverride(FLAG)
  const input = await fire(() => processSessionStartHooks('startup', { agentType: undefined }))
  check('the SessionStart hook ran and received its input', input !== null)
  check('the input is the startup input', input?.hook_event_name === 'SessionStart' && input?.source === 'startup', `${input?.hook_event_name}/${input?.source}`)
  check('model is the --model value', input?.model === FLAG, String(input?.model))
  check('model is the id the engine resolves for the session', input?.model === getEngineModel(), `${String(input?.model)} vs ${getEngineModel()}`)
  check('the other fields are the base fields and the source, nothing more', keysWithout(input, 'model') === BASE_KEYS, keysWithout(input, 'model'))
}

section('§2 A STARTUP PINNED IN SETTINGS ONLY')
{
  writeSettings()
  state.setEngineModelOverride(undefined)
  resetSettingsCache()
  check('the precondition: the model nothing chose differs from the pin', getEngineModel() !== PIN, getEngineModel())
  writeSettings({ model: PIN })
  const input = await fire(() => processSessionStartHooks('startup', { agentType: undefined }))
  check('model is the settings pin', input?.model === PIN, String(input?.model))
  check('model is the id the engine resolves for the session', input?.model === getEngineModel(), `${String(input?.model)} vs ${getEngineModel()}`)
}

section('§3 A STARTUP WITH NOTHING CHOSEN')
{
  writeSettings()
  state.setEngineModelOverride(undefined)
  const input = await fire(() => processSessionStartHooks('startup', { agentType: undefined }))
  const resolved = getEngineModel()
  check('model is the default the engine resolves', typeof input?.model === 'string' && input.model !== '' && input.model === resolved, `${String(input?.model)} vs ${resolved}`)
}

section('§4 THE HEADLESS BOOT FALLBACK (loadInitialMessages with no hook promise) FIRES THE SAME INPUT')
{
  writeSettings()
  state.setEngineModelOverride(FLAG)
  const input = await fire(() =>
    loadInitialMessages(noop, { continue: undefined, resume: undefined, resumeSessionAt: undefined, forkSession: undefined, outputFormat: 'text' }),
  )
  check('the fallback fired a startup input', input?.source === 'startup', String(input?.source))
  check('model is the --model value', input?.model === FLAG, String(input?.model))
  check('the other fields are the base fields and the source, nothing more', keysWithout(input, 'model') === BASE_KEYS, keysWithout(input, 'model'))
}

section('§5 agent_type STAYS WHAT IT WAS: ABSENT ON A MAIN THREAD WITHOUT AN AGENT, THE AGENT TYPE WHEN ONE RUNS')
{
  writeSettings()
  state.setEngineModelOverride(FLAG)
  const plain = await fire(() => processSessionStartHooks('startup', { agentType: undefined }))
  check('a main thread with no agent carries no agent_type', plain !== null && !('agent_type' in plain), Object.keys(plain ?? {}).sort().join(','))
  const agent = await fire(() => processSessionStartHooks('startup', { agentType: 'reviewer' }))
  check('a main thread running an agent carries its agent_type', agent?.agent_type === 'reviewer', String(agent?.agent_type))
  check('the same input carries the model', agent?.model === FLAG, String(agent?.model))
}

section('§6 A RESUME NAMES THE MODEL THE RESUMED SESSION RUNS ON')
{
  const SID = '00000000-0000-4000-8000-000000001300'
  const U_FIRST = '00000000-0000-4000-8000-000000001301'
  const U_REPLY = '00000000-0000-4000-8000-000000001302'
  const stamp = (n: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 30_000).toISOString()
  const envelope = (n: number, parentUuid: string | null, row: Record<string, unknown>): Record<string, unknown> => ({
    parentUuid,
    isSidechain: false,
    cwd: PROJ,
    sessionId: SID,
    version: '1.0.0',
    gitBranch: 'main',
    timestamp: stamp(n),
    ...row,
  })
  const transcriptPath = join(PROJ, `${SID}.jsonl`)
  const rows: Array<Record<string, unknown>> = [
    envelope(0, null, { type: 'user', uuid: U_FIRST, message: { role: 'user', content: 'first' } }),
    envelope(1, U_FIRST, {
      type: 'assistant',
      uuid: U_REPLY,
      requestId: 'req_first',
      message: { id: 'msg_first', type: 'message', role: 'assistant', model: RECORDED, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
    }),
    { type: 'model', model: RECORDED, sessionId: SID },
  ]
  writeFileSync(transcriptPath, rows.map(row => encodeTranscriptLine(transcriptPath, row).line).join(''))

  writeSettings()
  state.setEngineModelOverride(undefined)
  check('the precondition: the model nothing chose differs from the recorded one', getEngineModel() !== RECORDED, getEngineModel())
  const plain = await fire(() => loadConversationForResume(SID, transcriptPath))
  check('the resume fired its input for the resumed session', plain?.source === 'resume' && plain?.session_id === SID, `${plain?.source}/${plain?.session_id}`)
  check('model is the one the session was recorded on', plain?.model === RECORDED, String(plain?.model))
  check('the other fields are the base fields and the source, nothing more', keysWithout(plain, 'model') === BASE_KEYS, keysWithout(plain, 'model'))

  state.setEngineModelOverride(FLAG)
  const chosen = await fire(() => loadConversationForResume(SID, transcriptPath))
  check('a --model on the resume wins over the recorded one', chosen?.model === FLAG, String(chosen?.model))
}

section('§7 THE COMPACT ROAD IS UNCHANGED: THE CALLER\'S MODEL RIDES THROUGH')
{
  writeSettings()
  state.setEngineModelOverride(FLAG)
  const input = await fire(() => processSessionStartHooks('compact', { model: CALLER, agentType: undefined }))
  check('the compact input is the compact input', input?.hook_event_name === 'SessionStart' && input?.source === 'compact', `${input?.hook_event_name}/${input?.source}`)
  check('the model the caller passed is the model in the input, not the session default', input?.model === CALLER && CALLER !== getEngineModel(), String(input?.model))
  check('the other fields are the base fields and the source, nothing more', keysWithout(input, 'model') === BASE_KEYS, keysWithout(input, 'model'))
}

for (const dir of [HOME, PROJ]) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
  }
}

console.log(failures === 0 ? '\nprove-session-start-model: all green' : `\nprove-session-start-model: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
