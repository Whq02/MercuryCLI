#!/usr/bin/env bun
// ============================================================================
//  scripts/switchboard/prove-chat-forward-first-paint.ts — a chat-forward
//  boot paints before the session birth settles, and a refused birth says
//  why (FN-015 rank 12).
//
//  `mercury "<prompt>"` and an inline boot (MERCURY_FULLSCREEN=0) awaited
//  bornSession BEFORE launchRepl — the sole render site — so on a box where
//  the daemon is absent or bound-but-unresponsive (a FIRST RUN is exactly
//  the absent case) the terminal sat on the launcher's splash hold frame for
//  the whole handshake ladder (40 rounds of a 500 ms handshake plus a 250 ms
//  sleep, then a 30 s admission timeout) with nothing painted. And a refused
//  birth's reason — which names the actual remedy — reached only
//  logForDebugging, which returns immediately unless --debug was passed.
//
//  §1 the landing gate marks SYNCHRONOUSLY (so a birth that is started and
//     not awaited still holds the face from yielding)
//  §2 the birth door routes through that gate
//  §3 the boot: the birth is STARTED before the launch site and never
//     awaited there; the outcome lands as its own event
//  §4 the refusal SPEAKS: the reason rides the seat-receipt seam, which
//     queues until the screen subscribes and drains in order, above the
//     verbose gate
//  §5 the armed words wait for the landing they were armed for (the frame
//     does not) — the REPL's armed-message effect gates on the landing
//  §6 the retraction survives (a refused birth lands the Boot face, never a
//     settle-long flash of an empty chat)
//
//  Run:  ~/.bun/bin/bun run scripts/switchboard/prove-chat-forward-first-paint.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-chat-forward-first-paint-'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' the chat-forward boot paints first, and a refusal speaks')
console.log('============================================================')

const ROOT = join(import.meta.dir, '..', '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')

// ── §1 the landing gate marks synchronously ─────────────────────────────────
section('§1 withLanding — the gate is armed BEFORE the first await')
{
  const { withLanding, landingInFlight } = await import('../../src/services/engine-connector/focusedConnector.ts')
  check('no landing at rest', landingInFlight() === false)
  let release: (v: string) => void = () => {}
  const pending = new Promise<string>(r => {
    release = r
  })
  const landed = withLanding(pending)
  check('the gate is in flight on the SAME tick the landing starts (an unawaited birth still holds the face)', landingInFlight() === true)
  release('done')
  check('the landing resolves to its own value', (await landed) === 'done')
  check('the gate clears once it settles', landingInFlight() === false)
  // A refused landing clears the gate too — the face must never be held by
  // a birth that failed.
  const refused = withLanding(Promise.reject(new Error('refused')))
  check('a rejected landing is in flight while it runs', landingInFlight() === true)
  await refused.catch(() => undefined)
  check('a rejected landing still clears the gate', landingInFlight() === false)
}

// ── §2 the birth door routes through the gate ───────────────────────────────
section('§2 bornSession routes through the landing gate')
{
  const door = read('src', 'services', 'switchboard', 'bornSession.ts')
  check('the birth door wraps its work in withLanding', /return withLanding\(birth\(req\)\)/.test(door))
  check('the door still answers a typed refusal rather than throwing', /\{ ok: false; reason: string \}/.test(door))
}

// ── §3 the boot starts the birth and paints ─────────────────────────────────
section('§3 the boot — the birth is started, the launch site is not gated on it')
{
  const main = read('src', 'main.tsx')
  const block = main.slice(main.indexOf('THE CHAT-FORWARD BOOTS'), main.indexOf('await launchRepl('))
  check('the chat-forward block exists and precedes the launch site', block.length > 0 && block.length < 4000)
  check('the birth is STARTED (bornSession is called in the block)', /bornSession\(\{/.test(block))
  check('the birth is NOT awaited before the launch site (the first frame never waits on a daemon round-trip)', !/await bornSession\(/.test(block), 'await bornSession( still gates the paint')
  check('the outcome lands as its own event (a then/catch continuation on the birth)', /\.then\(/.test(block))
  check('launchRepl is still the sole launch site', (main.match(/await launchRepl\(/g) ?? []).length === 1)
}

// ── §4 the refusal speaks ───────────────────────────────────────────────────
section('§4 a refused birth reaches the screen (the seat-receipt seam)')
{
  const main = read('src', 'main.tsx')
  const block = main.slice(main.indexOf('THE CHAT-FORWARD BOOTS'), main.indexOf('await launchRepl('))
  check('the refusal mints a receipt carrying born.reason', /mintImmediateReceipt\([^)]*born\.reason/s.test(block), 'the reason still reaches only the debug log')
  check("the receipt is warning-level (never a quiet info row)", /mintImmediateReceipt\([\s\S]{0,200}?'warning'\)/.test(block))
  check('the debug line is kept beside it', /logForDebugging\(/.test(block))
  // The seam itself: a receipt minted BEFORE the screen subscribes is
  // queued and drained in order — the boot's exact shape.
  const receipts = await import('../../src/utils/model/seatReceipts.ts')
  receipts.mintImmediateReceipt('▲ the first receipt', 'warning')
  receipts.mintImmediateReceipt('▲ the second receipt', 'warning')
  const seen: Array<{ text: string; level: string }> = []
  const stop = receipts.subscribeSeatReceipts(r => seen.push({ text: r.text, level: r.level }))
  check('a receipt minted before the screen mounts still reaches it', seen.length === 2, JSON.stringify(seen))
  check('…in order, at the level it was minted', seen[0]?.text === '▲ the first receipt' && seen[1]?.text === '▲ the second receipt' && seen.every(r => r.level === 'warning'))
  stop()
  const hook = read('src', 'hooks', 'useSeatReceipts.ts')
  check('the screen subscribes the seam into the transcript', /subscribeSeatReceipts\(/.test(hook) && /setMessages/.test(hook))
  const repl = read('src', 'screens', 'REPL.tsx')
  check('the REPL mounts that hook', /useSeatReceipts\(\{/.test(repl))
}

// ── §5 the armed words wait for their landing ───────────────────────────────
section('§5 the armed message waits for the birth it was armed for')
{
  const repl = read('src', 'screens', 'REPL.tsx')
  const armedAt = repl.indexOf('const armedMessage = useAppState')
  const effect = repl.slice(armedAt, repl.indexOf('useConcourseLifecycleSignals(terminal)', armedAt))
  check('the armed-message effect exists', effect.length > 0 && effect.length < 3000)
  check('it holds while a landing is in flight (the words must not reach a resting slot)', /if \(landing\) return;/.test(effect), 'the effect submits regardless of the landing')
  check('the landing is a dependency, so the effect re-runs when the birth settles', /\}, \[armedMessage, landing, setAppState\]\)/.test(effect))
  check(
    'the landing subscription is declared before the effect (one subscription, hoisted)',
    repl.includes('const landing = useSyncExternalStore') &&
      repl.indexOf('const landing = useSyncExternalStore') < repl.indexOf('const armedMessage = useAppState'),
  )
  check('there is exactly ONE landing subscription in the screen', (repl.match(/const landing = useSyncExternalStore/g) ?? []).length === 1)
}

// ── §6 the retraction survives ──────────────────────────────────────────────
section('§6 a refused birth still lands the Boot face')
{
  const main = read('src', 'main.tsx')
  const block = main.slice(main.indexOf('THE CHAT-FORWARD BOOTS'), main.indexOf('await launchRepl('))
  check('the refusal retracts the explicit journey', /retractExplicitBootJourney\(\)/.test(block))
  const handover = read('src', 'substrate', 'splashHandover.ts')
  check('the retraction owner still clears the explicit-journey fact', /export function retractExplicitBootJourney\(\): void \{\s*explicitBootJourney = false/.test(handover))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-chat-forward-first-paint${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
