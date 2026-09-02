#!/usr/bin/env bun
// prove-timeout-not-cancelled — a hook overrunning its own timeout is not an
// operator cancel (field card FC-018). The per-hook timeout is folded into
// the reason-less combined abort signal, so an overrun classified as
// `aborted`, dressed as hook_cancelled — a registered NULL-RENDER — and a
// PreToolUse guard that outran its clock failed open with the abandonment
// reaching no channel. A timeout now classifies as a visible non-blocking
// error naming the overrun; a REAL outer cancel keeps the cancelled path.
//
//   §1 the overrun: outcome is not 'cancelled'; the attachment is visible
//      and names the timeout.
//   §2 the outer cancel control: an aborted batch signal still yields
//      'cancelled' (hook_cancelled).
//   §3 the fast-hook control: success unchanged.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'hook-timeout-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'hook-timeout-proj-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let settingsWriteSeq = 0
const writeHooks = (hooks: unknown): void => {
  mkdirSync(join(PROJ, '.mercury'), { recursive: true })
  const file = join(PROJ, '.mercury', 'settings.json')
  writeFileSync(file, JSON.stringify({ hooks }))
  // Distinct mtimes per write: the hook-config layer caches by mtime, and
  // two writes in the same second let a later section run an earlier
  // section's hooks.
  settingsWriteSeq += 2
  const stamp = new Date(Date.now() + settingsWriteSeq * 1000)
  utimesSync(file, stamp, stamp)
  // The hooks config also rides a process snapshot — drop it with the
  // settings cache or later sections run the first section's hooks.
  resetSettingsCache()
  resetHooksConfigSnapshot()
}
process.chdir(PROJ)

const { executeHooks } = await import('../../src/utils/hooks/engine.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { resetHooksConfigSnapshot } = await import('../../src/utils/hooks/hooksConfigSnapshot.ts')
// The hooks under proof are CHECKOUT-DELIVERED (the project's own
// .mercury/settings.json). A proof process never boots the interactive entry,
// so it reads as a headless road — and a never-trusted repository's own hooks
// do not run there (FC-144). This proof models the trusted project the
// operator accepted the dialog for: arm the session's trust before driving.
const { setSessionTrustAccepted } = await import('../../src/bootstrap/state.ts')
setSessionTrustAccepted(true)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

type Collected = { blocking: boolean; attachmentTypes: string[]; texts: string[] }
// Each section drives its OWN tool name + matcher: the hook config layer
// caches by content/mtime, and a same-second rewrite of the settings file
// let a later section execute an earlier section's hook.
const drive = async (toolName: string, signal?: AbortSignal): Promise<Collected> => {
  const collected: Collected = { blocking: false, attachmentTypes: [], texts: [] }
  const hookInput = {
    hook_event_name: 'PreToolUse',
    session_id: '00000000-0000-0000-0000-000000000000',
    transcript_path: join(PROJ, 't.jsonl'),
    cwd: PROJ,
    tool_name: toolName,
    tool_input: { command: 'echo probe' },
  } as never
  for await (const result of executeHooks({
    hookInput,
    toolUseID: 'tu_probe',
    matchQuery: toolName,
    ...(signal ? { signal } : {}),
  })) {
    if (result.blockingError) collected.blocking = true
    const message = (result as { message?: { attachment?: { type?: string } } }).message
    const attachment = message?.attachment as { type?: string; stderr?: string; content?: string } | undefined
    if (attachment?.type) collected.attachmentTypes.push(attachment.type)
    collected.texts.push(JSON.stringify(attachment ?? {}))
  }
  return collected
}

// The headless channel: a -p run's attachment reaches no stream, so the
// engine writes ONE stderr line per non-blocking failure. Captured here
// under the non-interactive posture; the interactive default writes none.
const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
const stderrLines: string[] = []
const realStderrWrite = process.stderr.write.bind(process.stderr)
const captureStderr = (on: boolean): void => {
  process.stderr.write = on
    ? ((chunk: string | Uint8Array): boolean => {
        stderrLines.push(String(chunk))
        return true
      }) as typeof process.stderr.write
    : realStderrWrite
}

section('§1 THE OVERRUN')
{
  writeHooks({ PreToolUse: [{ matcher: 'ProbeOverrun', hooks: [{ type: 'command', command: 'sleep 25; echo BLOCK 1>&2; exit 2', timeout: 1 }] }] })
  resetSettingsCache()
  setIsInteractive(false)
  captureStderr(true)
  const t0 = Date.now()
  const run = await drive('ProbeOverrun')
  const took = Date.now() - t0
  captureStderr(false)
  setIsInteractive(true)
  check(
    'headless: the overrun is ONE stderr line naming the hook, the event and the timeout (a -p run has no other channel)',
    stderrLines.some(line => /^hook .* \(PreToolUse\) timed out after 1s and was killed; the PreToolUse it guarded proceeded\n$/.test(line)),
    JSON.stringify(stderrLines).slice(0, 300),
  )
  check('the hook was actually killed by its clock (ran ~1s, not 25s)', took < 20000, `${took}ms`)
  check(
    'the overrun yields a VISIBLE attachment, not the null-rendered hook_cancelled (FC-018)',
    run.attachmentTypes.length > 0 && !run.attachmentTypes.includes('hook_cancelled'),
    JSON.stringify(run.attachmentTypes),
  )
  check(
    'and it NAMES the timeout',
    run.texts.some(t => /timed out|timeout/i.test(t)),
    JSON.stringify(run.texts).slice(0, 200),
  )
}

section('§2 THE OUTER-CANCEL CONTROL')
{
  writeHooks({ PreToolUse: [{ matcher: 'ProbeCancel', hooks: [{ type: 'command', command: 'sleep 25', timeout: 60 }] }] })
  resetSettingsCache()
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)
  const run = await drive('ProbeCancel', controller.signal)
  check(
    'a real outer cancel keeps the cancelled dressing (or ends silently)',
    run.attachmentTypes.every(t => t === 'hook_cancelled'),
    JSON.stringify(run.attachmentTypes),
  )
}

section('§3 THE BLOCKING CONTROL')
{
  // A guard that answers INSIDE its clock still blocks (exit-2 protocol).
  writeHooks({ PreToolUse: [{ matcher: 'ProbeBlock', hooks: [{ type: 'command', command: 'echo NO 1>&2; exit 2', timeout: 60 }] }] })
  resetSettingsCache()
  const run = await drive('ProbeBlock')
  check('an in-time exit-2 guard still BLOCKS', run.blocking === true, JSON.stringify(run.attachmentTypes))
}

section('§4 JSON THAT FAILS THE SCHEMA — visible, and reported headless')
{
  // exit 0 with a JSON body the schema refuses: a non-blocking error the
  // interactive road renders as an attachment; headless, one stderr line.
  writeHooks({ PreToolUse: [{ matcher: 'ProbeGarbage', hooks: [{ type: 'command', command: 'echo \'{"decision": "maybe"}\'; exit 0', timeout: 60 }] }] })
  resetSettingsCache()
  stderrLines.length = 0
  setIsInteractive(false)
  captureStderr(true)
  const run = await drive('ProbeGarbage')
  captureStderr(false)
  setIsInteractive(true)
  check('the schema refusal is a VISIBLE non-blocking error (never a silent proceed)', run.attachmentTypes.includes('hook_non_blocking_error'), JSON.stringify(run.attachmentTypes))
  check('…and it never blocks the tool', run.blocking === false)
  check(
    'headless: ONE stderr line names the hook, the event and the validation failure',
    stderrLines.some(line => /^hook .* \(PreToolUse\) returned JSON that failed validation: /.test(line)),
    JSON.stringify(stderrLines).slice(0, 300),
  )
}

rmSync(HOME, { recursive: true, force: true })
rmSync(PROJ, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-timeout-not-cancelled: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-timeout-not-cancelled: all green')
