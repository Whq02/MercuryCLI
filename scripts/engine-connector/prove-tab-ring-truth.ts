#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'tab-ring-')))
process.env['MERCURY_CONFIG_DIR'] = join(scratch, 'home')
mkdirSync(join(scratch, 'home'), { recursive: true })
process.env['MERCURY_CREDENTIAL_STORE'] = 'file'
process.env['MERCURY_OPERATOR'] = 'sam'
for (const k of ['MERCURY_CRITTER_IDLE', 'MERCURY_CRITTER_GAZE', 'MERCURY_CRITTER_SLEEP', 'MERCURY_LIVE_CLOCK', 'MERCURY_LIVE_GLYPHS']) {
  process.env[k] = '0'
}
delete process.env['TMUX']
delete process.env['STY']

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const { createTabRing } = await import('../../src/ink/useTerminalNotification.ts')
const { isProgressReportingAvailable } = await import('../../src/ink/session/capabilities.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

const RING = /^\x1b\]9;4;3;0(?:\x07|\x1b\\)$/
const CLEAR = /^\x1b\]9;4;0;0(?:\x07|\x1b\\)$/
const codesOf = (writes: string[]): string => writes.map(w => (RING.test(w) ? '3' : CLEAR.test(w) ? '0' : '?')).join('')

console.log('— R1 the owner —')
{
  const writes: string[] = []
  const ring = createTabRing(w => writes.push(w), () => true)
  const a = Symbol('a')
  const b = Symbol('b')
  ring.hold(a, false)
  check('R1 an idle hold writes nothing', writes.length === 0 && !ring.ringing())
  ring.hold(a, true)
  check('R1 a rising hold writes ONE indeterminate ring in the ConEmu form (9;4;3;0)', writes.length === 1 && RING.test(writes[0]!) && ring.ringing(), JSON.stringify(writes))
  ring.hold(a, true)
  check('R1 a repeated live hold writes nothing', writes.length === 1)
  ring.hold(b, true)
  check('R1 a second live holder shares the ring — nothing written', writes.length === 1)
  ring.hold(a, false)
  check('R1 one holder resting while another holds keeps the ring — nothing written', writes.length === 1 && ring.ringing())
  ring.release(b)
  check('R1 the last release writes ONE clear (9;4;0;0)', writes.length === 2 && CLEAR.test(writes[1]!) && !ring.ringing(), JSON.stringify(writes))
  ring.hold(a, false)
  ring.release(a)
  ring.release(Symbol('never-held'))
  check('R1 resting again, releasing again, releasing a stranger: nothing written', writes.length === 2)
  ring.hold(a, true)
  ring.hold(a, false)
  ring.hold(a, true)
  ring.hold(a, false)
  check('R1 two turns ⇒ ring · clear · ring · clear, strictly alternating', codesOf(writes) === '303030', codesOf(writes))
}

console.log('— R2 liveness only —')
{
  const writes: string[] = []
  const ring = createTabRing(w => writes.push(w), () => true)
  const seat = Symbol('seat')
  const unansweredToolUseIds = new Set(['toolu_left_without_a_result'])
  ring.hold(seat, true)
  ring.hold(seat, false)
  check('R2 an interrupt with a dangling tool id ends in a clear', codesOf(writes) === '30' && unansweredToolUseIds.size === 1, codesOf(writes))
  ring.hold(seat, true)
  ring.release(seat)
  check('R2 a session switch mid-turn (the mount goes) ends in a clear', codesOf(writes) === '3030', codesOf(writes))
  check('R2 the owner takes no tool set at all — its inputs are a holder and its liveness', ring.hold.length === 2 && ring.release.length === 1)
}

console.log('— R3 the gate —')
{
  const writes: string[] = []
  let available = false
  const ring = createTabRing(w => writes.push(w), () => available)
  const seat = Symbol('seat')
  ring.hold(seat, true)
  ring.hold(seat, false)
  check('R3 no ring where the terminal cannot draw one — and no clear for a ring that never rang', writes.length === 0 && !ring.ringing())
  available = true
  ring.hold(seat, true)
  ring.hold(seat, false)
  check('R3 the gate is asked at the rising edge: once the terminal can draw it, the turn rings and clears', codesOf(writes) === '30', codesOf(writes))
}

console.log('— R4 the capability owner —')
{
  check('R4 Windows Terminal draws the ring', isProgressReportingAvailable({ WT_SESSION: 'a-session' }, true) === true)
  check('R4 a non-TTY stdout never carries a ring, Windows Terminal included', isProgressReportingAvailable({ WT_SESSION: 'a-session' }, false) === false)
  check('R4 an unknown terminal does not', isProgressReportingAvailable({}, true) === false)
  check('R4 ConEmu does', isProgressReportingAvailable({ ConEmuANSI: 'ON' }, true) === true)
  check(
    'R4 iTerm2 from 3.6.6, ghostty from 1.2.0',
    isProgressReportingAvailable({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6' }, true) === true &&
      isProgressReportingAvailable({ TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.5.0' }, true) === false &&
      isProgressReportingAvailable({ TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.2.0' }, true) === true &&
      isProgressReportingAvailable({ TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.1.0' }, true) === false,
  )
}

console.log('— R5 the headless render —')
{
  const { streamRenderedMessages } = await import('../../src/utils/exportRenderer.tsx')
  const messages = [
    {
      type: 'user',
      uuid: 'u-1',
      timestamp: new Date(0).toISOString(),
      message: { role: 'user', content: 'name the harbour' },
    },
    {
      type: 'assistant',
      uuid: 'a-1',
      timestamp: new Date(0).toISOString(),
      requestId: undefined,
      message: {
        id: 'msg-1',
        model: 'claude-fable-5-1',
        role: 'assistant',
        type: 'message',
        stop_reason: 'tool_use',
        stop_sequence: null,
        content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/tmp/harbour.txt' } }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null, server_tool_use: null },
      },
    },
    {
      type: 'assistant',
      uuid: 'a-2',
      timestamp: new Date(0).toISOString(),
      requestId: undefined,
      message: {
        id: 'msg-2',
        model: 'claude-fable-5-1',
        role: 'assistant',
        type: 'message',
        stop_reason: 'end_turn',
        stop_sequence: null,
        content: [{ type: 'text', text: 'the harbour is named' }],
        usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: null, cache_creation_input_tokens: null, cache_creation: null, server_tool_use: null },
      },
    },
  ] as never
  const stdout: string[] = []
  const origWrite = process.stdout.write.bind(process.stdout)
  ;(process.stdout as { write: unknown }).write = ((chunk: unknown, ...rest: unknown[]) => {
    stdout.push(typeof chunk === 'string' ? chunk : String(chunk))
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as never
  let rendered = ''
  let renderError = ''
  try {
    await streamRenderedMessages(messages, [] as never, chunk => {
      rendered += chunk
    }, { columns: 100 })
  } catch (e) {
    renderError = String(e)
  } finally {
    ;(process.stdout as { write: unknown }).write = origWrite
  }
  const ringBytes = stdout.join('').match(/\x1b\]9;4;\d/g) ?? []
  check('R5 the headless export renders the conversation', renderError === '' && rendered.includes('the harbour is named'), renderError || rendered.slice(0, 120))
  check('R5 the headless render writes NO ring byte to the process stdout', ringBytes.length === 0, `${ringBytes.length} sequence(s)`)
}

console.log(failures === 0 ? '\n✅ tab-ring truth GREEN' : `\n❌ tab-ring truth RED — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
