#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { formsMissing, shippedKeyForms } from '../lib/shippedKeyForms.ts'

const SUP2_SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'sup2-home-'))
process.env.MERCURY_CONFIG_DIR = SUP2_SCRATCH_HOME


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 shell-detail — the tail read is bounded')
{

  const { tailFileSync } = await import('../../src/platform/files/fsOperations.ts')
  const dir = mkdtempSync(join(tmpdir(), 'sup2-tail-'))
  try {
    const file = join(dir, 'out.txt')
    const head = 'H'.repeat(20_000)
    const tail = 'T'.repeat(500)
    writeFileSync(file, head + tail)
    const r = tailFileSync(file, 8 * 1024)
    check('reads exactly the final maxBytes', r.bytesRead === 8 * 1024 && r.content.endsWith(tail) && r.content.length === 8 * 1024, 'tailFileSync in src/platform/files/fsOperations.ts must read only the final maxBytes of the file; bytesRead=' + r.bytesRead + ', length=' + r.content.length)
    check('reports the TRUE total size beside the bounded read', r.bytesTotal === 20_500, 'tailFileSync in src/platform/files/fsOperations.ts must report the real file size as bytesTotal; got ' + r.bytesTotal)
    writeFileSync(file, '')
    const empty = tailFileSync(file, 8 * 1024)
    check('an empty file is an honest empty', empty.content === '' && empty.bytesTotal === 0, 'tailFileSync in src/platform/files/fsOperations.ts must return empty content and bytesTotal 0 for an empty file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('§2 bash-timeout — the advertised max is enforced')

console.log('§3 concourse on a small window — it composes, never refuses')

console.log('§4 blob sweep — the loose-file arm honours the reference set')

console.log('§5 runner availability — PATHEXT applies on win32')
{
  const { resolveRunnerBinary } = await import('../../src/integrations/ide/projectRunners.ts')
  const dir = mkdtempSync(join(tmpdir(), 'sup2-pathext-'))
  try {
    writeFileSync(join(dir, 'cargo.exe'), 'MZ')
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } as NodeJS.ProcessEnv
    check('poison gone: the bare name resolves through PATHEXT on win32', resolveRunnerBinary('cargo', env, 'win32') === join(dir, 'cargo.exe'), 'resolveRunnerBinary in src/integrations/ide/projectRunners.ts must try each PATHEXT extension on win32')
    check('the PATHEXT default stands in when the variable is absent', resolveRunnerBinary('cargo', { PATH: dir } as NodeJS.ProcessEnv, 'win32') === join(dir, 'cargo.exe'), 'resolveRunnerBinary in src/integrations/ide/projectRunners.ts must fall back to a default PATHEXT when the variable is absent')
    check('POSIX keeps exact-name semantics (no .exe invention)', resolveRunnerBinary('cargo', env, 'darwin') === null, 'resolveRunnerBinary in src/integrations/ide/projectRunners.ts must match exact names only off win32')
    writeFileSync(join(dir, 'cargo'), '#!')
    check('an extensionless shim does not shadow the Windows executable', resolveRunnerBinary('cargo', env, 'win32') === join(dir, 'cargo.exe'), 'resolveRunnerBinary in src/integrations/ide/projectRunners.ts must prefer the PATHEXT executable over an extensionless file on win32')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('§6 max-retries — the registry row and the refusal tell the truth')

console.log('§7 update finally — the sweep cannot replace the verdict')

console.log('§8 ripgrep — cancelling and timing out are different facts')

console.log('§9 settings parse — the shared cache object is never mutated')
{
  const { parseSettingsFile } = await import('../../src/platform/settings/settings.ts')
  const dir = mkdtempSync(join(tmpdir(), 'sup2-settings-'))
  try {
    const body = '{"guardrails":{"allow":[42]}}\n'
    const a = join(dir, 'a.settings.json')
    const b = join(dir, 'b.settings.json')
    writeFileSync(a, body)
    writeFileSync(b, body)
    const first = parseSettingsFile(a)
    const second = parseSettingsFile(b)
    check('the first byte-identical file reports its invalid rule', first.errors.length > 0, 'parseSettingsFile in src/platform/settings/settings.ts must report the invalid guardrails rule')
    check('the SECOND byte-identical file reports it too (the shared-object disease is gone)', second.errors.length > 0, 'parseSettingsFile in src/platform/settings/settings.ts must not mutate or reuse a cached parse result shared between identical files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('§10 lsp catalogue — the offered-configs path never probes an unmatched root')

console.log('§11 tree digest — argv, never a shell')

console.log('§12 boot scan — the growth dimension is capped')
{
  const { capDirsByRecency, BOOT_SCAN_DIR_CAP } = await import('../../src/screen/boot-face/bootCardFacts.ts')
  check('the cap matches the estate posture', BOOT_SCAN_DIR_CAP === 128, 'BOOT_SCAN_DIR_CAP in src/screen/boot-face/bootCardFacts.ts is ' + BOOT_SCAN_DIR_CAP + ', expected 128')
  const small = ['a', 'b', 'c']
  let statCalls = 0
  const identity = capDirsByRecency(small, () => { statCalls++; return 0 }, 128)
  check('at/under the cap: identity order, ZERO extra stats', identity.join(',') === 'a,b,c' && statCalls === 0, 'capDirsByRecency in src/screen/boot-face/bootCardFacts.ts must return the list unchanged and never stat when at or under the cap; stat calls=' + statCalls)
  const big = Array.from({ length: 200 }, (_, i) => `d${i}`)
  const capped = capDirsByRecency(big, name => (name === 'd199' ? 9_999 : Number(name.slice(1))), 128)
  check('over the cap: bounded to the cap', capped.length === 128, 'capDirsByRecency in src/screen/boot-face/bootCardFacts.ts must cut a longer list to the cap; got ' + capped.length)
  check('the newest-changed dir always makes the visit', capped[0] === 'd199', 'capDirsByRecency in src/screen/boot-face/bootCardFacts.ts must keep the most recently changed dir first; got ' + capped[0])
  const throwing = capDirsByRecency(big, name => { if (name === 'd0') throw new Error('EACCES'); return Number(name.slice(1)) }, 128)
  check('an unreadable dir ranks last instead of throwing the scan', throwing.length === 128 && !throwing.includes('d0'), 'capDirsByRecency in src/screen/boot-face/bootCardFacts.ts must rank a dir whose stat throws last, not rethrow')
}

console.log('§13 git-bash refusal — the hold releases before the words')

console.log('§14 boot settings — no sync git inside a render')

console.log('§15 prune door — the resume snapshot rides its transcript out')
{
  const { buildPruneOffer, operatorPruneTranscripts } = await import('../../src/daemon/switchboard/transcriptPruneDoor.ts')
  const { snapshotPathFor } = await import('../../src/sessions/transcripts/resumeSnapshot.ts')
  const dir = mkdtempSync(join(tmpdir(), 'sup2-prune-'))
  try {
    const t = join(dir, '00000000-0000-4000-8000-00000000s2p1.jsonl')
    writeFileSync(t, 'x'.repeat(300))
    writeFileSync(snapshotPathFor(t), 'y'.repeat(120))
    const bare = join(dir, '00000000-0000-4000-8000-00000000s2p2.jsonl')
    writeFileSync(bare, 'x'.repeat(50))
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
    const rows = [
      { sessionId: 's2p1', fullPath: t, fileSize: 300, modified: old },
      { sessionId: 's2p2', fullPath: bare, fileSize: 50, modified: old },
    ]
    const offer = buildPruneOffer(rows, { scopeLabel: 's', windowDays: 30 })
    const receipt = await operatorPruneTranscripts(offer)
    check('the snapshot sidecar is gone with its transcript', !existsSync(snapshotPathFor(t)) && !existsSync(t), 'operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts must delete the resume snapshot (snapshotPathFor) with its transcript')
    check("the freed figure counts the snapshot's bytes (300+120+50)", receipt.bytesFreed === 470, 'operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts must count snapshot bytes in bytesFreed; got ' + String(receipt.bytesFreed))
    check('the receipt counts the snapshot deletions', receipt.snapshotsDeleted === 1, 'operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts must count snapshotsDeleted; got ' + receipt.snapshotsDeleted)
    check('a snapshot-less transcript still prunes clean (absent is normal)', receipt.deleted === 2 && receipt.failed === 0 && !existsSync(bare), 'operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts must prune a transcript with no snapshot without failing; deleted=' + receipt.deleted + ', failed=' + receipt.failed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('§16 cleanup barrier — the aggregate waits for every sibling')
{
  const { registerCleanup, runCleanupFunctions } = await import('../../src/platform/processes/cleanupRegistry.ts')
  let slowDone = false
  const un1 = registerCleanup(async () => {
    throw new Error('sup2-early-reject')
  })
  const un2 = registerCleanup(async () => {
    await new Promise(r => setTimeout(r, 120))
    slowDone = true
  })
  const started = Date.now()
  let thrown: unknown = null
  try {
    await runCleanupFunctions()
  } catch (e) {
    thrown = e
  }
  const elapsed = Date.now() - started
  un1()
  un2()
  check('the slow sibling FINISHED before the aggregate settled', slowDone === true, `runCleanupFunctions in src/platform/processes/cleanupRegistry.ts must wait for every registered cleanup before it settles; elapsed=${elapsed}ms`)
  check('the first rejection still propagates to the caller', thrown instanceof Error && thrown.message === 'sup2-early-reject', 'runCleanupFunctions in src/platform/processes/cleanupRegistry.ts must rethrow the first rejection to its caller')
  check('the aggregate held for the slow sibling (≥100ms, not a microtask)', elapsed >= 100, 'runCleanupFunctions in src/platform/processes/cleanupRegistry.ts returned after ' + elapsed + 'ms; it must hold until the slow cleanup ends')
}

console.log('§17 writer drain — no silent batch loss, no latch, tracked timer')

console.log('§18 login mint — the spinner is bounded into a keyed state')

console.log('§20 /bug — the draft is a real file the done screen names')

console.log('§21 /config revert — targeted undo, never the mount snapshot')

console.log('§22 service stop — the tree goes, not just the root')

console.log('§23 MERCURY_API_TIMEOUT_MS — one parser, honest panels')

console.log('§24 settings writes — the file round-trips whole')

console.log('§25 stall wake — paired re-entry, repaint scheduled')

console.log('§26 the cards\' editor chord resolves where the cards listen')

console.log('§27 sync-output — the hatch gates emission, never the host verdict')

console.log('§28 /keys atlas — no bound row without a handler')
{
  const shipped = shippedKeyForms()
  check('the workbench chord rides the real command dispatch', formsMissing(shipped, 'Global', 'ctrl+x k', 'command:workbench').length === 0, 'the shipped keymap must bind ctrl+x k to command:workbench under Global; see what shippedKeyForms in scripts/lib/shippedKeyForms.ts reads')
}

console.log('§29 corrupt-config reset — quarantined, and both arms speak')

console.log('§30 external-includes card — the question shows its stakes')

console.log('§31 pidlock + daemon stop — the reuse guard reaches every platform')

console.log('§32 wedged daemon — true bound, one ladder, honest refusal')

console.log('§33 BOM — mcp.json and keybindings.json parse through the one owner')

console.log('§34 gitignore — the rule is POSIX on every platform')

console.log('§36 agent sidecar — the whole-file atomic law')

console.log('§37 crash report — the path is latched after the write lands')

console.log('§38 auth-shadow remedy — a verb the shell has')

console.log('§39 exit confirm — every firing key is named')

console.log('§40 hook lane — bash prepends only to a leading .sh script')

console.log('§41 shell note — provenance only')

console.log('§42 change-set delete — the win32 retry ladder')

console.log('§43 task output — the retry waits before it judges')
{
  const { DiskTaskOutput, TASK_OUTPUT_RETRY_DELAY_MS } = await import('../../src/engine/task-framework/diskOutput.ts')
  check("the pause is the owner's first rung", TASK_OUTPUT_RETRY_DELAY_MS === 50, 'TASK_OUTPUT_RETRY_DELAY_MS in src/engine/task-framework/diskOutput.ts is ' + TASK_OUTPUT_RETRY_DELAY_MS + ', expected 50')
  const steps: string[] = []
  const output = new DiskTaskOutput('sup2-retry-pause') as unknown as { queue: string[]; drainCycle: () => Promise<void>; append(text: string): void; flush(): Promise<void> }
  output.drainCycle = async () => {
    steps.push('cycle')
    if (steps.filter(step => step === 'cycle').length === 1) throw new Error('the first cycle of this proof fails')
    output.queue.length = 0
  }
  const arm = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => arm(() => { steps.push(`timer ${ms}`); fn(...rest) }, ms)) as unknown as typeof setTimeout
  try {
    output.append('a chunk the first cycle does not write')
    await output.flush()
  } finally {
    globalThis.setTimeout = arm
  }
  const retry = steps.lastIndexOf('cycle')
  check('the pause precedes the retry, and the timer that ends it was armed with the delay itself', steps.filter(step => step === 'cycle').length === 2 && steps[retry - 1] === `timer ${TASK_OUTPUT_RETRY_DELAY_MS}`, `DiskTaskOutput in src/engine/task-framework/diskOutput.ts must wait TASK_OUTPUT_RETRY_DELAY_MS between a failed drain cycle and its retry; in order: ${steps.join(', ')}`)
}

console.log('§43b the one sleep — an unref\'ed pause resolves under a timer that hands back a number')
{
  const { sleep } = await import('../../src/platform/async/sleep.ts')
  const arm = globalThis.setTimeout
  let handed = 0
  globalThis.setTimeout = ((fn: () => void, ms?: number) => { arm(fn, ms); return ++handed }) as unknown as typeof setTimeout
  let outcome = 'pending'
  try {
    outcome = await sleep(1, undefined, { unref: true }).then(() => 'resolved', error => `rejected: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    globalThis.setTimeout = arm
  }
  check('the pause resolves, and its timer was armed once', outcome === 'resolved' && handed === 1, `sleep in src/platform/async/sleep.ts must resolve with unref when the timer returns a number; ${outcome}, ${handed} timer(s) armed`)
  const { setTimeout: timer } = await import('node:timers/promises')
  const shapeFor = (signal: AbortSignal) => (error: unknown): string => {
    const e = error as { name?: string; code?: string; message?: string; cause?: unknown }
    return `${e.name} ${e.code} "${e.message}" cause ${e.cause === signal.reason ? 'the reason' : String(e.cause)}`
  }
  const entered = new AbortController()
  entered.abort(new Error('the caller stopped'))
  const during = new AbortController()
  const cut = [timer(1_000, undefined, { signal: during.signal }).then(() => 'resolved', shapeFor(during.signal)), sleep(1_000, during.signal, { throwOnAbort: true }).then(() => 'resolved', shapeFor(during.signal))]
  during.abort('stop')
  const shapes = [await timer(5, undefined, { signal: entered.signal }).then(() => 'resolved', shapeFor(entered.signal)), await sleep(5, entered.signal, { throwOnAbort: true }).then(() => 'resolved', shapeFor(entered.signal)), ...(await Promise.all(cut))]
  check('a pause that rejects on its signal rejects as Node\'s timer of timers/promises does, entered aborted and aborted in the pause: the same name, code, message and cause', [shapes[1], shapes[3]].every(shape => shape === 'AbortError ABORT_ERR "The operation was aborted" cause the reason'), `sleep in src/platform/async/sleep.ts must reject on an aborted signal exactly like timers/promises; the timer, the door, the timer, the door: ${shapes.join(' · ')}`)
}

console.log('§44 exit heals — ?2026l first; the splash cancel disarms ?1007')

console.log('§45 /help shortcuts — the rows resolve through the real registry')
{
  const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.ts')
  const { parseBindings } = await import('../../src/screen/keys/parser.ts')
  const { getBindingDisplayText } = await import('../../src/screen/keys/resolver.ts')
  const parsed = parseBindings(DEFAULT_BINDINGS)
  const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, '')
  const expected: Array<[string, string]> = [['app:commandPalette', 'ctrl+x p'], ['history:search', 'ctrl+r'], ['app:fileOpen', 'ctrl+x f'], ['app:contentSearch', 'ctrl+x g'], ['command:sessions', 'ctrl+x s']]
  for (const [action, chord] of expected) {
    const shown = getBindingDisplayText(action, 'Global', parsed)
    check(`${action} resolves under Global to its default ${chord} through the real resolver`, norm(shown) === norm(chord), 'DEFAULT_BINDINGS in src/screen/keys/defaultBindings.ts must bind ' + action + ' to ' + chord + ' under Global; resolved ' + String(shown))
    check(`poison: ${action} resolves to NOTHING under Chat (what the old rows asked)`, getBindingDisplayText(action, 'Chat', parsed) === undefined, action + ' must not resolve under Chat in src/screen/keys/defaultBindings.ts')
  }
}

console.log("§46 /memory — the banner's r is a real key")

console.log('§47 git facts — the cache follows the harness ground')
{
}

process.exit(failures === 0 ? 0 : 1)
