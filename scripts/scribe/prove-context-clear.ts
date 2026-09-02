#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-context-clear.ts
//  PROOF (#31): the Scribe can CLEAR the Implementer's context — a `control`
//  `clear` over the bus RESPAWNS the Implementer (fresh transcript) instead of
//  delivering an inert "[control clear]" text frame it can't act on. The real
//  clear is a respawn (reconfigureLongLived with the same spec ⇒ fresh transcript,
//  respawn-if-idle-else-queue so it never wipes mid-write). Autocompact-for-both:
//  the Scribe foreground rides the base auto-compaction; the Implementer's long-lived
//  context is managed by this clear/respawn. Fake roster + temp mailbox.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-context-clear.ts
// ============================================================================
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const bridge = (await import('../../src/daemon/scribeDispatchBridge.js')) as typeof import('../../src/daemon/scribeDispatchBridge.js')
const bus = (await import('../../src/utils/scribe/scribeBus.js')) as typeof import('../../src/utils/scribe/scribeBus.js')

console.log('============================================================')
console.log(' Scribe clears Implementer context (#31) — proof')
console.log('============================================================')

const tmp = mkdtempSync(join(tmpdir(), 'hermes-clear-'))
process.env.MERCURY_CONFIG_DIR = tmp
const mailbox = await import('../../src/utils/teammateMailbox.js')
const seed = async (e: unknown) => mailbox.writeToMailbox('implementer', { from: 'scribe', text: bus.serializeScribeEnvelope(e as Parameters<typeof bus.serializeScribeEnvelope>[0]), timestamp: new Date().toISOString() }, 'scribe')
const mkRoster = (rec: string[]) => ({ reply: async (_s: string, text: string) => { rec.push(text); return true } })

section('a `clear` control RESPAWNS (onClear fired), not delivered as text')
await seed(bus.buildControl('scribe', 'clear'))
let cleared = 0
const recClear: string[] = []
const delivered = await bridge.drainScribeDispatches(mkRoster(recClear), { short: 'implementer', agentName: 'implementer', teamName: 'scribe', onClear: () => { cleared++ } })
check('onClear fired exactly once (respawn requested)', cleared === 1)
check('clear was NOT delivered to stdin as text', delivered === 0 && !recClear.some(t => /control clear/.test(t)))

section('gate-off (no onClear) ⇒ clear delivers as a control text frame (unchanged)')
const tmp2 = mkdtempSync(join(tmpdir(), 'hermes-clear2-'))
process.env.MERCURY_CONFIG_DIR = tmp2
await mailbox.writeToMailbox('implementer', { from: 'scribe', text: bus.serializeScribeEnvelope(bus.buildControl('scribe', 'clear')), timestamp: new Date().toISOString() }, 'scribe')
const recNoClear: string[] = []
const del2 = await bridge.drainScribeDispatches(mkRoster(recNoClear), { short: 'implementer', agentName: 'implementer', teamName: 'scribe' })
check('no onClear ⇒ clear delivered as text (byte-identical legacy behavior)', del2 === 1 && recNoClear.some(t => /control clear/.test(t)))

section('a non-clear control (pause) still delivers as text even WITH onClear')
const tmp3 = mkdtempSync(join(tmpdir(), 'hermes-clear3-'))
process.env.MERCURY_CONFIG_DIR = tmp3
await mailbox.writeToMailbox('implementer', { from: 'scribe', text: bus.serializeScribeEnvelope(bus.buildControl('scribe', 'pause')), timestamp: new Date().toISOString() }, 'scribe')
let cleared3 = 0
const recPause: string[] = []
const del3 = await bridge.drainScribeDispatches(mkRoster(recPause), { short: 'implementer', agentName: 'implementer', teamName: 'scribe', onClear: () => { cleared3++ } })
check('pause control delivers as text, onClear NOT fired', del3 === 1 && cleared3 === 0 && recPause.some(t => /control pause/.test(t)))
delete process.env.MERCURY_CONFIG_DIR

section('wiring — daemon respawns on clear; the Scribe pack permits it (not too sensitive)')
const main = src('daemon', 'main.ts')
check('main.ts wires onClear ⇒ reconfigureLongLived(implementer) (respawn = fresh transcript)', /onClear: \(\) => \{ r\.reconfigureLongLived\('implementer', \{\}\) \}/.test(main))
const pack = src('utils', 'scribe', 'scribePack.ts')
check('scribe pack: may CLEAR the Implementer (control clear)', /CLEAR the Implementer.s context/.test(pack) && /`control` `clear`/.test(pack))
check('scribe pack: only when near-full AND radically different (not too sensitive)', /near full AND the next task is RADICALLY different/.test(pack) && /Do NOT clear routinely/.test(pack))

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL CONTEXT-CLEAR PROOFS PASS')
else console.log(`❌ ${failures} CONTEXT-CLEAR PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
