#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { rmSync } from 'node:fs'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

const { scrubbedSessionEnvNotice, shortScrubbedSessionEnvNotice, sessionEnvNoticeForResult, resetSessionEnvNoticeForTesting } = await import('../../src/tools/shared/sessionEnvNotice.ts')

const MEASURED = ['MERCURY_BOOT_ENV_APPLIED', 'MERCURY_ENTRYPOINT', 'MERCURY_SAMPLES', 'MERCURY_SKIP_PERMISSIONS', 'NODE_COMPILE_CACHE']
const EXPECTED = "[session env scrubbed: MERCURY_BOOT_ENV_APPLIED, MERCURY_ENTRYPOINT, MERCURY_SAMPLES, MERCURY_SKIP_PERMISSIONS, NODE_COMPILE_CACHE — Mercury's own stamps, not the operator's; inherit_session_env: true keeps them]"

section('§1 the full notice for the five measured names is the 214-byte form')
const full = scrubbedSessionEnvNotice(MEASURED)
check('the notice is the expected text, byte for byte', full === EXPECTED, JSON.stringify(full))
check('it is 214 bytes', Buffer.byteLength(full, 'utf8') === 214, `${Buffer.byteLength(full, 'utf8')} bytes`)
check('it names every scrubbed variable in order', full.includes(MEASURED.join(', ')))
check('it still names inherit_session_env', full.includes('inherit_session_env'))
check('it says whose the values are', full.includes("Mercury's own stamps, not the operator's"))
check('it is one line', !full.includes('\n'))

section('§2 the short form and the once-per-session latch are unchanged')
check('the short later form is byte-identical to before', shortScrubbedSessionEnvNotice(['MERCURY_MODEL']) === '[session env scrubbed: MERCURY_MODEL]')
resetSessionEnvNoticeForTesting()
const first = sessionEnvNoticeForResult({ scrubbed: MEASURED, commandText: 'ls' })
const second = sessionEnvNoticeForResult({ scrubbed: MEASURED, commandText: 'ls' })
const third = sessionEnvNoticeForResult({ scrubbed: MEASURED, commandText: 'echo $MERCURY_SAMPLES' })
check('the first result of a session carries the full notice', first === EXPECTED, JSON.stringify(first))
check('a later result that names no stamp carries nothing', second === '')
check('a later result that names a stamp carries the short line for it alone', third === '[session env scrubbed: MERCURY_SAMPLES]', JSON.stringify(third))
check('the full notice and the short line share one opening, so a reader that strips `[session env scrubbed…]` strips both', first.startsWith('[session env scrubbed: ') && third.startsWith('[session env scrubbed: '))

try {
  rmSync(proofHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
