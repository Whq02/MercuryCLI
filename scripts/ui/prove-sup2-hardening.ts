#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SUP2_SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'sup2-home-'))
process.env.MERCURY_CONFIG_DIR = SUP2_SCRATCH_HOME

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

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
  const dialog = read('src/components/tasks/ShellDetailDialog.tsx')
  check('poison gone: no readFileSync CALL in the dialog (prose naming the old form may stand)', !dialog.includes('readFileSync('))
  check('the bounded owner is the read', dialog.includes('tailFileSync(path, TAIL_BYTES)'))

  const { tailFileSync } = await import('../../src/utils/fsOperations.ts')
  const dir = mkdtempSync(join(tmpdir(), 'sup2-tail-'))
  try {
    const file = join(dir, 'out.txt')
    const head = 'H'.repeat(20_000)
    const tail = 'T'.repeat(500)
    writeFileSync(file, head + tail)
    const r = tailFileSync(file, 8 * 1024)
    check('reads exactly the final maxBytes', r.bytesRead === 8 * 1024 && r.content.endsWith(tail) && r.content.length === 8 * 1024)
    check('reports the TRUE total size beside the bounded read', r.bytesTotal === 20_500)
    writeFileSync(file, '')
    const empty = tailFileSync(file, 8 * 1024)
    check('an empty file is an honest empty', empty.content === '' && empty.bytesTotal === 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('§2 bash-timeout — the advertised max is enforced')
{
  const bash = read('src/tools/BashTool/BashTool.tsx')
  const ps = read('src/tools/PowerShellTool/PowerShellTool.tsx')
  const clamp = 'Math.min(requestedTimeout || getDefaultTimeoutMs(), getMaxTimeoutMs())'
  check('poison gone: no unclamped effectiveTimeout in BashTool', !bash.includes('effectiveTimeout = requestedTimeout || getDefaultTimeoutMs()'))
  check('BashTool clamps to the advertised max', bash.includes(`const effectiveTimeout = ${clamp}`))
  check('the two shell lanes share one clamp spelling', ps.includes(`const effectiveTimeout = ${clamp}`))
  check('the advertisement still names the same accessor the clamp reads', bash.includes('max ${getMaxTimeoutMs()}'))
}

console.log('§3 concourse too-small — the notice names the window, not the pane')
{
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('poison gone: the notice no longer prints the pane width', !layout.includes('this window is {cols}×{termRows}'))
  check('the notice prints the terminal columns', layout.includes('this window is {termCols}×{termRows}'))
  check('the geometry still rides the frame columns', layout.includes('const cols = frameCols ?? termCols'))
}

console.log('§4 blob sweep — the loose-file arm honours the reference set')
{
  const cleanup = read('src/utils/cleanup.ts')
  const fileArm = cleanup.slice(cleanup.indexOf('} else if (toolResultEntry.isFile())'))
  const dirArm = cleanup.slice(cleanup.indexOf('if (toolResultEntry.isDirectory())'), cleanup.indexOf('} else if (toolResultEntry.isFile())'))
  check('the directory arm still consults referenced', dirArm.includes('referenced?.has(toolResultEntry.name)'))
  check('poison gone: the file arm consults referenced too', fileArm.includes('referenced?.has(toolResultEntry.name)'))
  check('the file-arm guard precedes the stat/unlink', fileArm.indexOf('referenced?.has(toolResultEntry.name)') < fileArm.indexOf('await fs.unlink(toolResultPath)'))
  const pattern = /tool-results[/\\]+([A-Za-z0-9_.-]+)/g
  const hit = [...'Full output saved to: C:\\home\\proj\\sess\\tool-results\\toolu_9.txt'.matchAll(pattern)]
  check('the pointer capture yields the dirent name with its extension', hit.length === 1 && hit[0]?.[1] === 'toolu_9.txt')
  check('the in-tree capture still admits dots (the set can hold file names)', cleanup.includes('[A-Za-z0-9_.-]+'))
}

console.log('§5 runner availability — PATHEXT applies on win32')
{
  const { resolveRunnerBinary } = await import('../../src/services/ide/projectRunners.ts')
  const dir = mkdtempSync(join(tmpdir(), 'sup2-pathext-'))
  try {
    writeFileSync(join(dir, 'cargo.exe'), 'MZ')
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } as NodeJS.ProcessEnv
    check('poison gone: the bare name resolves through PATHEXT on win32', resolveRunnerBinary('cargo', env, 'win32') === join(dir, 'cargo.exe'))
    check('the PATHEXT default stands in when the variable is absent', resolveRunnerBinary('cargo', { PATH: dir } as NodeJS.ProcessEnv, 'win32') === join(dir, 'cargo.exe'))
    check('POSIX keeps exact-name semantics (no .exe invention)', resolveRunnerBinary('cargo', env, 'darwin') === null)
    writeFileSync(join(dir, 'cargo'), '#!')
    check('an extensionless hit still wins where it exists', resolveRunnerBinary('cargo', env, 'win32') === join(dir, 'cargo'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('§6 max-retries — the registry row and the refusal tell the truth')
{
  const retry = read('src/services/api/withRetry.ts')
  const registry = read('src/substrate/flagRegistry.ts')
  check('the ruled no-run parse stands untouched', retry.includes('return Number.parseInt(env, 10)'))
  check('poison gone: the registry row no longer promises a fall-through', !registry.includes('unparseable values fall through to the default'))
  check('the registry row names the refusal', registry.includes('refuse without one request'))
  check('the zero-attempt throw names the variable, not exhaustion', retry.includes('is not a non-negative integer — no request was attempted'))
  check('a genuine exhaustion still says exhausted', retry.includes("'retry attempts exhausted'"))
  const neverRuns = (n: number): boolean => !(1 <= n + 1)
  check('NaN and -1 are the zero-attempt shapes; 0 and 10 run', neverRuns(Number.NaN) && neverRuns(-1) && !neverRuns(0) && !neverRuns(10))
}

console.log('§7 update finally — the sweep cannot replace the verdict')
{
  const svc = read('src/services/privateChannel/updateService.ts')
  const fin = svc.slice(svc.indexOf('previousKept: previous !== null'), svc.indexOf('// ── rollback'))
  check('the sweep is guarded inside the finally', fin.includes('try {') && fin.includes('rmSync(staging, { recursive: true, force: true })') && fin.includes('catch (sweepError)'))
  check('the lock release stands OUTSIDE the guarded sweep, still in the finally', fin.indexOf('releaseUpdateLock(roots)') > fin.indexOf('catch (sweepError)'))
  check('poison gone: no bare rmSync line remains between the verdict and the release', !fin.includes('    rmSync(staging, { recursive: true, force: true })\n    releaseUpdateLock'))
}

console.log('§8 ripgrep — cancelling and timing out are different facts')
{
  const rg = read('src/utils/ripgrep.ts')
  check("poison gone: ABORT_ERR is no longer part of the bare timeout test", !rg.includes("outcome.signal === 'SIGKILL' || code === 'ABORT_ERR'"))
  check('an unsalvaged abort throws an AbortError-named interruption', rg.includes("abortError.name = 'AbortError'"))
  check('the deadline carve-out keys on the signal reason', rg.includes("name === 'TimeoutError'"))
  const { isAbortError } = await import('../../src/utils/errors.ts')
  const abortShaped = new Error('The search was interrupted before it finished.')
  abortShaped.name = 'AbortError'
  check('the tool layer reads the thrown shape as an interrupt', isAbortError(abortShaped) === true)
  const timeoutShaped = new Error('timed out')
  timeoutShaped.name = 'RipgrepTimeoutError'
  check('a real timeout still is NOT an interrupt', isAbortError(timeoutShaped) === false)
  const deadline = AbortSignal.timeout(1)
  await new Promise(r => setTimeout(r, 20))
  check("the runtime premise holds: AbortSignal.timeout's reason is a TimeoutError", deadline.aborted && (deadline.reason as { name?: string }).name === 'TimeoutError')
}

console.log('§9 settings parse — the shared cache object is never mutated')
{
  const settings = read('src/utils/settings/settings.ts')
  check('the reader clones before the in-place passes', settings.includes('structuredClone(shared)'))
  check('poison gone: the mutators no longer receive the cached object', !settings.includes('const parsed = safeParseJSON(stripBOM(raw), false)\n  adoptLegacySupercodeSpelling(parsed)'))
  const { parseSettingsFile } = await import('../../src/utils/settings/settings.ts')
  const dir = mkdtempSync(join(tmpdir(), 'sup2-settings-'))
  try {
    const body = '{"permissions":{"allow":[42]}}\n'
    const a = join(dir, 'a.settings.json')
    const b = join(dir, 'b.settings.json')
    writeFileSync(a, body)
    writeFileSync(b, body)
    const first = parseSettingsFile(a)
    const second = parseSettingsFile(b)
    check('the first byte-identical file reports its invalid rule', first.errors.length > 0)
    check('the SECOND byte-identical file reports it too (the shared-object disease is gone)', second.errors.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('§10 lsp catalogue — the offered-configs path never probes an unmatched root')
{
  const cat = read('src/services/lsp/serverCatalogue.ts')
  check('the probe takes a per-call-site binaryProbe mode', cat.includes("binaryProbe: 'always' | 'when-root-matched' = 'always'"))
  check('an unmatched root short-circuits before resolveBinary in lazy mode', cat.includes("if (binaryProbe === 'when-root-matched' && !rootMatched) return { entry, rootMatched }"))
  check('catalogueServerConfigs passes the lazy mode', cat.includes("probeCatalogueEntry(entry, cwd, cwdEntries, 'when-root-matched')"))
  const records = cat.slice(cat.indexOf('export function serverCatalogueRecords'))
  check("the records view keeps the full probe (its detected-not-offered rows are the point)", records.includes('probeCatalogueEntry(entry, cwd, cwdEntries)') && !records.includes("'when-root-matched'"))
  const { probeCatalogueEntry } = await import('../../src/services/lsp/serverCatalogue.ts')
  const entry = { id: 'sup2-probe', label: 'x', languages: [], binaries: ['sup2-definitely-absent-binary'], rootMarkers: ['sup2.marker.never'], extensionToLanguage: {} } as unknown as Parameters<typeof probeCatalogueEntry>[0]
  const lazy = probeCatalogueEntry(entry, process.cwd(), ['README.md'], 'when-root-matched')
  check('lazy + unmatched root ⇒ no binary field at all', lazy.rootMatched === false && lazy.binaryPath === undefined)
}

console.log('§11 tree digest — argv, never a shell')
{
  const vs = read('src/utils/verification/verificationState.ts')
  check('poison gone: no execSync command strings remain', !vs.includes('execSync('))
  check('the four calls are argv execFileSync', vs.includes('execFileSync(gitExe(), args, {') && ["['read-tree', 'HEAD']", "['add', '-A', '--', '.'", "['reset', '-q', '--', ...HARNESS_DIRS]", "['write-tree', '--missing-ok'"].every(a => vs.includes(a)))
  check('the async twin still spells argv too', vs.includes('execFile(gitExe(), args, { windowsHide: true, cwd, env,'))
}

console.log('§12 boot scan — the growth dimension is capped')
{
  const facts = read('src/utils/bootCardFacts.ts')
  check('poison gone: the raw uncapped loop is out', !facts.includes('for (const d of readdirSync(root)) {'))
  check('the visit rides the cap helper', facts.includes('for (const d of capDirsByRecency(readdirSync(root)'))
  const { capDirsByRecency, BOOT_SCAN_DIR_CAP } = await import('../../src/utils/bootCardFacts.ts')
  check('the cap matches the estate posture', BOOT_SCAN_DIR_CAP === 128)
  const small = ['a', 'b', 'c']
  let statCalls = 0
  const identity = capDirsByRecency(small, () => { statCalls++; return 0 }, 128)
  check('at/under the cap: identity order, ZERO extra stats', identity.join(',') === 'a,b,c' && statCalls === 0)
  const big = Array.from({ length: 200 }, (_, i) => `d${i}`)
  const capped = capDirsByRecency(big, name => (name === 'd199' ? 9_999 : Number(name.slice(1))), 128)
  check('over the cap: bounded to the cap', capped.length === 128)
  check('the newest-changed dir always makes the visit', capped[0] === 'd199')
  const throwing = capDirsByRecency(big, name => { if (name === 'd0') throw new Error('EACCES'); return Number(name.slice(1)) }, 128)
  check('an unreadable dir ranks last instead of throwing the scan', throwing.length === 128 && !throwing.includes('d0'))
}

console.log('§13 git-bash refusal — the hold releases before the words')
{
  const wp = read('src/utils/windowsPaths.ts')
  check('the hold-release owner is imported', wp.includes("import { releaseLauncherAltHoldNow } from '../ink/launcherAltHold.js'"))
  const releases = [...wp.matchAll(/releaseLauncherAltHoldNow\(\)/g)].length
  check('both refusal arms release the hold', releases === 2)
  const overrideArm = wp.slice(wp.indexOf('const override = process.env.MERCURY_GIT_BASH_PATH'), wp.indexOf('for (const candidate of gitBashCandidatePaths'))
  check('override arm: release precedes the write', overrideArm.indexOf('releaseLauncherAltHoldNow()') !== -1 && overrideArm.indexOf('releaseLauncherAltHoldNow()') < overrideArm.indexOf('writeSync(2,'))
  const missingArm = wp.slice(wp.indexOf('for (const candidate of gitBashCandidatePaths'))
  check('missing-git arm: release precedes the write', missingArm.indexOf('releaseLauncherAltHoldNow()') !== -1 && missingArm.indexOf('releaseLauncherAltHoldNow()') < missingArm.indexOf('writeSync('))
}

console.log('§14 boot settings — no sync git inside a render')
{
  const screen = read('src/components/BootSettingsScreen.tsx')
  check('poison gone: no spawnSync CALL anywhere in the face', !screen.includes('spawnSync('))
  check('the probe is async execFile', screen.includes("import { execFile } from 'node:child_process'"))
  check('the mount effect owns the probe (initializer no longer does)', screen.includes('useEffect(() => gitTailProbe(setDirTail), [])') && !screen.includes('useState(() => gitTailOnce())'))
  check('unmount cancels the callbacks (no setState after close)', screen.includes('alive = false'))
  check('the timeouts the sync form budgeted stay as async caps', screen.includes('timeout: 800') && screen.includes('timeout: 1500'))
}

console.log('§15 prune door — the resume snapshot rides its transcript out')
{
  const door = read('src/utils/sessionStorage/transcriptPruneDoor.ts')
  check('the candidate freezes the snapshot path (never re-resolved at Yes)', door.includes('snapshotPath: snapshotPathFor(row.fullPath)'))
  const { buildPruneOffer, operatorPruneTranscripts } = await import('../../src/utils/sessionStorage/transcriptPruneDoor.ts')
  const { snapshotPathFor } = await import('../../src/utils/sessionStorage/resumeSnapshot.ts')
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
    check('the snapshot sidecar is gone with its transcript', !existsSync(snapshotPathFor(t)) && !existsSync(t))
    check("the freed figure counts the snapshot's bytes (300+120+50)", receipt.bytesFreed === 470, String(receipt.bytesFreed))
    check('the receipt counts the snapshot deletions', receipt.snapshotsDeleted === 1)
    check('a snapshot-less transcript still prunes clean (absent is normal)', receipt.deleted === 2 && receipt.failed === 0 && !existsSync(bare))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log('§16 cleanup barrier — the aggregate waits for every sibling')
{
  const reg = read('src/utils/cleanupRegistry.ts')
  check('poison gone: no bare Promise.all aggregate', !reg.includes('await Promise.all('))
  check('allSettled-then-throw is the shape', reg.includes('Promise.allSettled') && reg.includes('if (firstRejection) throw'))
  const { registerCleanup, runCleanupFunctions } = await import('../../src/utils/cleanupRegistry.ts')
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
  check('the slow sibling FINISHED before the aggregate settled', slowDone === true, `elapsed=${elapsed}ms`)
  check('the first rejection still propagates to the caller', thrown instanceof Error && thrown.message === 'sup2-early-reject')
  check('the aggregate held for the slow sibling (≥100ms, not a microtask)', elapsed >= 100)
}

console.log('§17 writer drain — no silent batch loss, no latch, tracked timer')
{
  const writer = read('src/utils/sessionStorage/writer.ts')
  check('poison gone: no async timer callback in the writer (the tree-wide census shape)', !/setTimeout\(async/.test(writer.replace(/^\s*\/\/.*$/gm, '')))
  check('the drain run is tracked and activeDrain clears in a finally', writer.includes('if (this.activeDrain === run) this.activeDrain = null'))
  check('the un-landed tail requeues at the FRONT with its resolvers', writer.includes('queue.unshift(...batch.slice(landed))'))
  check('the requeue records the failure and the drain rethrows so flush() callers see the truth', /queue\.unshift\(\.\.\.batch\.slice\(landed\)\)\s*\n\s*failures\.push\(\{ filePath, error: err \}\)/.test(writer) && writer.includes('if (failures.length === 1) throw failures[0]!.error'))
  check('the retry backs off (100ms base, 5s cap)', writer.includes('this.FLUSH_INTERVAL_MS * 2 ** this.drainFailureStreak, 5_000'))
  check('a failure streak reports once to the error ring', writer.includes('if (this.drainFailureStreak === 0) logError(err)'))
  check('a successful drain resets the streak', writer.includes('this.drainFailureStreak = 0'))
  check('the failure re-arm rides the same finally (requeued remainder earns the retry)', /finally\(\(\) => \{[\s\S]{0,400}this\.scheduleDrain\(\)/.test(writer))
}

console.log('§18 login mint — the spinner is bounded into a keyed state')
{
  const oauth = read('src/services/oauth/client.ts')
  const posts = [...oauth.matchAll(/axios\.post[^(]*\(/g)].length
  const timeouts = [...oauth.matchAll(/\{ timeout: (?:EXCHANGE|REVOKE)_TIMEOUT_MS/g)].length
  check('every axios.post in the file is bounded', posts === timeouts && posts >= 4, `posts=${posts} timeouts=${timeouts}`)
  check('the mint call carries the sibling bound', /API_KEY_URL,\s*\{\},\s*\{ timeout: EXCHANGE_TIMEOUT_MS/.test(oauth))
  const flow = read('src/components/ConsoleOAuthFlow.tsx')
  check("the error state keeps esc live (the bounded wedge's landing)", flow.includes("state.name === 'error'"))
}

console.log('§19 teammates board — esc lives while busy, the footer says so')
{
  const board = read('src/components/mercury-ui/screens/TeammateChatsView.tsx')
  check('poison gone: the busy arm no longer swallows every key', !/if \(busy\) return/.test(board))
  check('esc closes while busy', /if \(busy\) \{[\s\S]{0,700}if \(key\.escape\) onClose\(\)[\s\S]{0,40}return/.test(board))
  check('the busy footer stops advertising a dead board', board.includes("busy ? 'working… · esc close (the spawn/stop finishes in the daemon)'"))
}

console.log('§20 /bug — the draft is a real file the done screen names')
{
  const feedback = read('src/components/Feedback.tsx')
  check('poison gone: the gathered report is no longer voided (code lines only)', !/^\s*void report\b/m.test(feedback.replace(/^\s*\/\/.*$/gm, '')))
  check('the draft persists through the atomic-publish law', feedback.includes('durableAtomicPublishSync(path,') && feedback.includes("join(getMercuryHome(), 'feedback')"))
  check('the done screen names the path (and the refused-write truth)', feedback.includes('the local draft (with the transcript): {paths?.json}') && feedback.includes('could not be written'))
  check('the one yes stands: the exact body is shown before it leaves, esc keeps the draft', feedback.includes('enter to file it · esc to keep the draft only') && feedback.includes('bytes) will be filed'))
  const cmd = read('src/commands/feedback/index.ts')
  check('the palette line says the road: the reporter\'s own GitHub CLI, the prefilled browser form without it, the local draft kept', !cmd.includes('becomes a GitHub issue') && cmd.includes('through your GitHub CLI') && cmd.includes('prefilled issue form opens in your browser') && cmd.includes('local draft stays'))
}

console.log('§21 /config revert — targeted undo, never the mount snapshot')
{
  const cfg = read('src/components/Settings/Config.tsx')
  check('poison gone: no wholesale snapshot publish', !cfg.includes('saveGlobalConfig(() => snapshots.global)'))
  check('the dialog tracks its touched global keys at the one write door', cfg.includes('globalTouchedRef.current.add(key)'))
  check('the revert merges the snapshot values onto CURRENT (lock re-read respected)', cfg.includes('saveGlobalConfig(current => {') && cfg.includes('const restored = { ...current }'))
  check('an untouched dialog reverts no global key at all', cfg.includes('if (globalTouchedRef.current.size > 0)'))
  check('a key absent at mount deletes on revert (born-in-dialog keys go)', cfg.includes('if (snap[key] === undefined) delete restored[key]'))
  check('permissions revert moves ONLY defaultMode', cfg.includes('permissions: { defaultMode: snapshots.user.permissions?.defaultMode }') && !cfg.includes('permissions: snapshots.user.permissions'))
}

console.log('§22 service stop — the tree goes, not just the root')
{
  const svc = read('src/services/projectServices/serviceManager.ts')
  check('the tree owner is imported', svc.includes("import { endProcessTree } from '../../utils/processGroup.js'"))
  const stop = svc.slice(svc.indexOf('export async function stopService'), svc.indexOf('export async function restartService'))
  check('win32 first strike is the whole tree', /win32'\) \{[\s\S]{0,700}await endProcessTree\(record\.pid, 'SIGKILL'\)/.test(stop))
  check('posix keeps the graceful TERM first', stop.includes("signalPid(record.pid, 'SIGTERM')"))
  check('the escalation is a tree strike on both platforms', (stop.match(/await endProcessTree\(record\.pid, 'SIGKILL'\)/g) ?? []).length === 2)
  check('poison gone: no bare root-only SIGKILL escalation remains', !stop.includes("signalPid(record.pid, 'SIGKILL')"))
}

console.log('§23 API_TIMEOUT_MS — one parser, honest panels')
{
  const { apiTimeoutMsOverride } = await import('../../src/utils/envValidation.ts')
  check("the disease spelling is rejected whole ('60s' ⇒ null, never 60ms)", apiTimeoutMsOverride('60s') === null)
  check('negatives and zero are refused (a positive floor at last)', apiTimeoutMsOverride('-1') === null && apiTimeoutMsOverride('0') === null)
  check('a plain integer passes; whitespace tolerated', apiTimeoutMsOverride('120000') === 120_000 && apiTimeoutMsOverride(' 120000 ') === 120_000)
  check('unset/empty defer to the caller default', apiTimeoutMsOverride(undefined) === null && apiTimeoutMsOverride('') === null)
  const owner = 'apiTimeoutMsOverride'
  const client = read('src/services/api/client.ts')
  const stream = read('src/services/providers/anthropic/streamCore.ts')
  const proxy = read('src/utils/proxy.ts')
  check('client.ts rides the owner (its parseInt gone)', client.includes(`${owner}() ?? DEFAULT_API_TIMEOUT_MS`) && !client.includes("Number.parseInt(process.env.API_TIMEOUT_MS"))
  check('streamCore rides the owner (its parseInt gone)', stream.includes(`${owner}() ?? 300_000`) && !stream.includes("parseInt(process.env.API_TIMEOUT_MS"))
  check('proxy rides the owner (its Number() arm gone)', proxy.includes(`${owner}() ?? 600_000`))
  const panel = read('src/components/messages/SystemAPIErrorMessage.tsx')
  check("poison gone: the panel no longer glues 'ms' onto the raw value", !panel.includes('${process.env.API_TIMEOUT_MS}ms'))
  check('the panel names an unparseable spelling with the remedy', panel.includes('is not a whole number of milliseconds'))
  const assist = read('src/components/messages/AssistantTextMessage.tsx')
  check('the assistant variant stops advising a bigger broken value', assist.includes('which is not a whole number of milliseconds'))
}

console.log('§24 settings writes — the file round-trips whole')
{
  const settings = read('src/utils/settings/settings.ts')
  check('poison gone: the write base is no longer the filtered parse', !settings.includes('const existing = parseSettingsFileUncached(readPath)'))
  check('the raw base still refuses a mid-edit file', settings.includes('refusing to overwrite a file mid-edit'))
  check('the legacy-key adoption still persists through writes', /adoptLegacySupercodeSpelling\(baseSettings\)/.test(settings))
  const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
  const userPath = join(SUP2_SCRATCH_HOME, 'settings.json')
  writeFileSync(
    userPath,
    `${JSON.stringify(
      {
        permissions: { allow: [42, 'Read(//ok/**)'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', note: 'why this exists', hooks: [] }] },
      },
      null,
      2,
    )}\n`,
  )
  const { error } = updateSettingsForSource('userSettings', { language: 'en' })
  check('the unrelated write succeeds', error === null, String(error))
  const after = JSON.parse(readFileSync(userPath, 'utf8')) as {
    language?: string
    permissions?: { allow?: unknown[] }
    hooks?: { PreToolUse?: Array<{ note?: string }> }
  }
  check('the write applied its own key', after.language === 'en')
  check('the warned-invalid rule SURVIVES the unrelated write', Array.isArray(after.permissions?.allow) && after.permissions.allow.includes(42))
  check('the valid sibling rule survives beside it', after.permissions?.allow?.includes('Read(//ok/**)') === true)
  check("the hook matcher's unknown key survives (the nested-strip disease)", after.hooks?.PreToolUse?.[0]?.note === 'why this exists')
}

console.log('§25 stall wake — paired re-entry, repaint scheduled')
{
  const session = read('src/ink/root/screen-session.ts')
  check('the paired composite exists at the byte owner', session.includes('export function wakeReenterAltBytes') && session.includes('return EXIT_ALT_SCREEN + reenterAltBytes(mouseTracking)'))
  const { wakeReenterAltBytes, reenterAltBytes } = await import('../../src/ink/root/screen-session.ts')
  const { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } = await import('../../src/ink/termio/dec.ts')
  const paired = wakeReenterAltBytes(false)
  check('the bytes carry ?1049l BEFORE ?1049h', paired.indexOf(EXIT_ALT_SCREEN) === 0 && paired.indexOf(EXIT_ALT_SCREEN) < paired.indexOf(ENTER_ALT_SCREEN))
  check('the enter half is byte-identical to the one enter composite', paired === EXIT_ALT_SCREEN + reenterAltBytes(false))
  const ink = read('src/ink/ink.tsx')
  const reassert = ink.slice(ink.indexOf('reassertTerminalModes(includeAltScreen'), ink.indexOf('repaintAfterNestedAltScreenClose'))
  check('poison gone: the stall path no longer calls the bare re-enter', !reassert.includes('this.reenterAltScreen()'))
  check('the stall path rides the paired composite', reassert.includes('wakeReenterAltBytes(this.mouseTracking)'))
  check('the erased screen earns a SCHEDULED repaint', reassert.includes('this.needsEraseBeforePaint = true') && reassert.includes('this.scheduleRender()'))
  check('the SIGCONT resume keeps its plain fresh enter (the shell exited alt there)', ink.includes('this.reenterAltScreen();\n      this.armScreenWatchdog();'))
}

console.log('§26 plan card — the advertised chord resolves where the card listens')
{
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
  const { parseBindings } = await import('../../src/keybindings/parser.ts')
  const { resolveKey } = await import('../../src/keybindings/resolver.ts')
  const bindings = parseBindings(DEFAULT_BINDINGS as never)
  const ctrlG = { ctrl: true, meta: false, shift: false, super: false } as never
  const inCard = resolveKey('g', ctrlG, ['Confirmation', 'Global'] as never, bindings)
  check('ctrl+g resolves to chat:externalEditor in the Confirmation context', inCard.type === 'match' && (inCard as { action?: string }).action === 'chat:externalEditor')
  const inChat = resolveKey('g', ctrlG, ['Chat', 'Global'] as never, bindings)
  check('the composer is untouched (no ctrl+g there — its chord stays ctrl+x ctrl+e)', inChat.type === 'none')
  const card = read('src/components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx')
  check("the card still advertises ctrl+g and still registers under 'Confirmation'", card.includes('ctrl+g edit in {editorName}') && /useKeybinding\(\s*'chat:externalEditor'[\s\S]{0,2000}\{ context: 'Confirmation' \}/.test(card))
  const graph = read('src/keybindings/actionGraph.ts')
  check('the action row admits both contexts (atlas honesty)', graph.includes("'chat:externalEditor': { description: 'Edit the draft in your external editor (on the plan card: the plan file)', contexts: ['Chat', 'Confirmation'] }"))
}

console.log('§27 sync-output — the hatch gates emission, never the host verdict')
{
  const caps = read('src/ink/session/capabilities.ts')
  check('the capability sniff is hatch-free', caps.includes('function sniffSynchronizedOutput(): boolean') && !caps.slice(caps.indexOf('function sniffSynchronizedOutput'), caps.indexOf('// LIVE latch')).includes('isSyncOutputForcedOff'))
  check('the latch seeds from the capability sniff', caps.includes('let syncOutputSupported = sniffSynchronizedOutput()'))
  check('emission still loses to the hatch at every read', /syncOutputSupportedNow\(\): boolean \{\s*\n\s*if \(isSyncOutputForcedOff\(\)\) return false/.test(caps))
  check('the capability read exists for the host verdict', caps.includes('export function syncOutputCapabilityNow(): boolean'))
  check('poison gone: the probe upgrade records under the hatch', !/upgradeSyncOutputSupport\(\): void \{\s*\n\s*if \(isSyncOutputForcedOff\(\)\) return/.test(caps))
  const profile = read('src/ink/session/terminalProfile.ts')
  check('the host-class row reads CAPABILITY', profile.includes('const sync = probe.syncOutput ?? syncOutputCapabilityNow()'))
  check('the /health synchronized-output row still reads EMISSION (armed truth)', profile.includes('const sync = probe.syncOutput ?? syncOutputSupportedNow()'))
  const { isSynchronizedOutputSupported, syncOutputSupportedNow, syncOutputCapabilityNow, upgradeSyncOutputSupport } = await import('../../src/ink/session/capabilities.ts')
  delete process.env.TMUX
  process.env.MERCURY_NO_SYNC_OUTPUT = '1'
  upgradeSyncOutputSupport()
  check('under the hatch: capability true, emission false, public read false', syncOutputCapabilityNow() === true && syncOutputSupportedNow() === false && isSynchronizedOutputSupported() === false)
  delete process.env.MERCURY_NO_SYNC_OUTPUT
  check('hatch lifted: the recorded capability arms emission at once (the self-clearing rescue)', syncOutputSupportedNow() === true)
}

console.log('§28 /keys atlas — no bound row without a handler')
{
  const bindings = read('src/keybindings/defaultBindings.ts')
  const graph = read('src/keybindings/actionGraph.ts')
  check('the workbench chord rides the real command dispatch', bindings.includes("'ctrl+x k': 'command:workbench'"))
  for (const dead of ["'crew:open-board'", "'settings:search'", "'confirm:toggle'", "'confirm:nextField'", "'chat:submit'", "'history:previous'", "'history:next'"]) {
    check(`poison gone: ${dead} bound nowhere and out of the graph`, !bindings.includes(`: ${dead}`) && !graph.includes(`  ${dead}: {`))
  }
  const composer = read('src/hooks/useTextInput.ts')
  check('the composer keys keep working through their own path (returnKey/history handling present)', /return|history/i.test(composer))
  const prover = read('scripts/cockpit-interaction/prove-action-graph.ts')
  check('the retirements are pinned against revival', prover.includes("'crew:open-board', 'settings:search', 'confirm:toggle', 'confirm:nextField',"))
}

console.log('§29 corrupt-config reset — quarantined, and both arms speak')
{
  const dlg = read('src/components/InvalidConfigDialog.tsx')
  check('the corrupt bytes are quarantined before the overwrite', dlg.indexOf('copyFileSync(error.filePath, quarantinePath)') !== -1 && dlg.indexOf('copyFileSync(error.filePath, quarantinePath)') < dlg.indexOf('writeFileSync(\n                      error.filePath'))
  check('the quarantine rides the one backups home', dlg.includes('getConfigBackupDir()') && dlg.includes('.corrupted.reset-'))
  check('a failed reset SAYS SO on stderr via writeSync (the exit-road law)', dlg.includes('the reset could not write') && dlg.includes('writeSync('))
  check('a successful reset names the quarantine', dlg.includes('the corrupt bytes are kept at'))
  check('poison gone: no silent catch-then-exit remains', !/catch \(writeError\) \{\s*\n\s*logError\(writeError\)\s*\n\s*gracefulShutdownSync\(1\)/.test(dlg))
  const cfg = read('src/utils/config/globalConfig.ts')
  check('the backups-home owner is exported for the gate', cfg.includes('export function getConfigBackupDir'))
}

console.log('§30 external-includes card — the question shows its stakes')
{
  const dlg = read('src/components/ExternalInstructionIncludesDialog.tsx')
  check('the card paints its own guide with the esc truth', dlg.includes('esc answers No — the answer is saved for this'))
  check("esc still answers 'no' (the persisted contract unchanged)", dlg.includes("onCancel={() => handleSelection('no')}"))
  const helpers = read('src/interactiveHelpers.tsx')
  check('the boot mount names the includes (from the memoized walk)', helpers.includes('getExternalInstructionIncludes(await getInstructionFiles(true))') && helpers.includes('externalIncludes={includes}'))
}

console.log('§31 pidlock + daemon stop — the reuse guard reaches every platform')
{
  const lock = read('src/substrate/pidLock.ts')
  check('the token rides the one cross-platform owner (no second CIM spelling)', lock.includes("from '../daemon/ownerWatch.js'") && !lock.includes('Get-CimInstance'))
  check('acquire records a token on every platform', lock.includes('...(await currentProcStartAnyPlatform()).procStartField'))
  check('holderAlive takes the pre-fetched live token', lock.includes('liveToken?: string | null'))
  check("a gone answer ('') is dead; unknown stays alive", lock.includes("if (current === '') return false") && lock.includes('current !== null && current !== undefined && current !== holder.procStart'))
  check('the sync fallback never spawns on the loop (cached-or-refresh)', lock.includes('getProcessStartTokenCachedOrRefresh(holder.pid)'))
  check('all three async callers pre-fetch', (lock.match(/await liveTokenFor\(/g) ?? []).length === 3)
  const main = read('src/daemon/main.ts')
  const stopArm = main.slice(main.indexOf('async function daemonStopCmd'), main.indexOf('async function daemonRestartCmd'))
  check('the lock-only leftover is swept under the ENOCONN dead-confirm', stopArm.includes('swept a lock-only leftover') && stopArm.includes("reply.code === 'ENOCONN'") && stopArm.indexOf("reply.code === 'ENOCONN'") < stopArm.indexOf('swept a lock-only leftover'))
  check('a live-by-identity lock holder is named, never stolen', stopArm.includes('supervisor.lock is held by live pid') && stopArm.includes("liveness: 'assume-alive'"))
  check('the sweep is the existing confirmed-dead owner', stopArm.includes('await clearDeadSupervisorRecords()'))
}

console.log('§32 wedged daemon — true bound, one ladder, honest refusal')
{
  const ens = read('src/services/switchboard/ensureDaemon.ts')
  check('poison gone: the ~10s claim is replaced by the two true bounds', !ens.includes('(bounded, ~10s)') && ens.includes('≈30s against a pipe that is BOUND but never'))
  check("the 'starting' ladder is single-flighted", ens.includes('waiting ??= awaitUsable(hs).finally(() => {'))
  check('the ladder arithmetic stands (40 × 500ms + 250ms)', ens.includes('tries = 40') && ens.includes('timeoutMs: 500') && ens.includes('setTimeout(res, 250)'))
  const born = read('src/services/switchboard/bornSession.ts')
  check("poison gone: the refusal no longer promises '↵ again starts it'", !born.includes('↵ again starts it and retries'))
  check('the refusal names the retry and the wedge remedy', born.includes('`mercury daemon stop` clears a daemon that holds the pipe but never answers'))
}

console.log('§33 BOM — .mcp.json and keybindings.json parse through the one owner')
{
  const mcp = read('src/services/mcp/config.ts')
  const kb = read('src/keybindings/loadUserBindings.ts')
  check('poison gone: no bare JSON.parse(raw) at either door', !mcp.includes("JSON.parse(raw)") && !kb.includes("JSON.parse(raw)"))
  check('both doors strip through jsonRead.stripBOM', mcp.includes('JSON.parse(stripBOM(raw))') && kb.includes('JSON.parse(stripBOM(raw))'))
  const { stripBOM } = await import('../../src/utils/jsonRead.ts')
  check('a BOM-prefixed document parses after the strip', JSON.parse(stripBOM('\uFEFF{"mcpServers":{}}')).mcpServers !== undefined)
}

console.log('§34 gitignore — the rule is POSIX on every platform')
{
  const gi = read('src/utils/git/gitignore.ts')
  check('the entry folds separators before it is written or compared', gi.includes("const entry = `**/${filename.split('\\\\').join('/')}`"))
  check('poison gone: no raw-filename entry', !gi.includes('const entry = `**/${filename}`'))
  check('the fold arithmetic: a win32 spelling yields the POSIX rule', `**/${'.mercury\\settings.local.json'.split('\\').join('/')}` === '**/.mercury/settings.local.json')
}

console.log('§35 daemon teardown — the key clears before the record it is checked against')
{
  const main = read('src/daemon/main.ts')
  const i = main.indexOf('if (controlEnabled) await clearControlKey().catch(() => {})')
  const j = main.indexOf('if (controlEnabled) await clearSupervisorState().catch(() => {})')
  check('both clears still run on the graceful path', i !== -1 && j !== -1)
  check('the key clear PRECEDES the record clear (the guard reads the record)', i < j)
}

console.log('§36 agent sidecar — the whole-file atomic law')
{
  const paths = read('src/utils/sessionStorage/paths.ts')
  const fn = paths.slice(paths.indexOf('export async function writeAgentMetadata'), paths.indexOf('export async function writeAgentMetadata') + 900)
  check('poison gone: no truncating writeFile in writeAgentMetadata', !fn.includes('await writeFile(path, JSON.stringify(metadata))'))
  check('the sidecar publishes through durableAtomicPublish', fn.includes('await durableAtomicPublish(path, JSON.stringify(metadata))'))
}

console.log('§37 crash report — the path is latched after the write lands')
{
  const cr = read('src/utils/crashReport.ts')
  const write = cr.indexOf('writeFileSync(\n      file,')
  const latch = cr.indexOf('lastReportPath = file')
  check('the write exists and the latch follows it', write !== -1 && latch !== -1 && latch > write)
  check('poison gone: no latch ahead of the write', cr.indexOf('lastReportPath = file') === cr.lastIndexOf('lastReportPath = file'))
}

console.log('§38 auth-shadow remedy — a verb the shell has')
{
  const errs = read('src/services/api/errors.ts')
  check('the win32 fork names both Windows shells', errs.includes("Remove-Item Env:") && errs.includes('cmd: set ${authSource}='))
  check('POSIX keeps unset', errs.includes(': `unset ${authSource}`'))
  check('poison gone: no unconditional unset remedy', !errs.includes('? `restart Mercury (or unset ${authSource}) to use your saved login`'))
}

console.log('§39 exit confirm — every firing key is named')
{
  const card = read('src/components/MercuryExitConfirm.tsx')
  check('enter still quits and esc still stays (behavior untouched)', card.includes('if (key.return || input === \'y\' || input === \'Y\')') && card.includes("if (key.escape || input === 'n' || input === 'N')"))
  check('the legend names ↵ beside quit and esc beside stay', card.includes('↵ quit') && card.includes('esc stay'))
}

console.log('§40 hook lane — bash prepends only to a leading .sh script')
{
  const ex = read('src/utils/hooks/execution.ts')
  check('poison gone: no whole-command .sh match', !ex.includes("command.trim().match(/\\.sh(\\s|$|\")/)"))
  const LEADING_SH_SCRIPT = /^("[^"]*\.sh"|'[^']*\.sh'|\S+\.sh)(?:\s|$)/
  check('the leading token decides (bare or quoted)', ex.includes(`const firstToken = /${LEADING_SH_SCRIPT.source}/.exec(trimmed)`) && ex.includes("if (!firstToken || trimmed.startsWith('bash ')) return command"))
  check('a compound with a trailing script is left alone', !LEADING_SH_SCRIPT.test('npm run format && ./fix.sh'))
  check('a leading bare script is caught', LEADING_SH_SCRIPT.test('./x.sh --flag') && LEADING_SH_SCRIPT.test('./x.sh'))
  check('a leading QUOTED script with a space in its path is caught (the Windows spelling)', LEADING_SH_SCRIPT.test('"C:\\Users\\Jane Doe\\hooks\\fmt.sh" --check') && LEADING_SH_SCRIPT.test("'./my hooks/x.sh'"))
  check('a non-script first token is left alone', !LEADING_SH_SCRIPT.test('npm run lint') && !LEADING_SH_SCRIPT.test('bash ./x.sh'))
}

console.log('§41 shell note — provenance only')
{
  const sc = read('src/utils/ShellCommand.ts')
  check('poison gone: the numeric 143 arm is out', !sc.includes('killedByTimeoutPolicy || code === 143'))
  check('the timeout note keys on the policy flag', sc.includes('} else if (killedByTimeoutPolicy) {'))
}

console.log('§42 change-set delete — the win32 retry ladder')
{
  const cs = read('src/services/changeTransaction/changeSetCommit.ts')
  check('the delete step rides the retry helper', cs.includes('await unlinkWithWin32Retry(t.canonicalPath)'))
  check("the helper's ladder is the owner's constant", cs.includes('WIN32_RENAME_RETRY_DELAYS_MS[attempt]') && cs.includes('isTransientWin32FsCode(code)'))
  check('poison gone: no bare unlink on the delete branch', !/kind === 'delete'\) \{[\s\S]{0,400}await unlink\(t\.canonicalPath\)/.test(cs))
}

console.log('§43 task output — the retry waits before it judges')
{
  const dio = read('src/utils/task/diskOutput.ts')
  const { TASK_OUTPUT_RETRY_DELAY_MS } = await import('../../src/utils/task/diskOutput.ts')
  check("the pause is the owner's first rung", TASK_OUTPUT_RETRY_DELAY_MS === 50)
  check('the pause precedes the retry', dio.indexOf('setTimeout(r, TASK_OUTPUT_RETRY_DELAY_MS)') !== -1 && dio.indexOf('setTimeout(r, TASK_OUTPUT_RETRY_DELAY_MS)') < dio.indexOf('await this.drainCycle()', dio.indexOf('setTimeout(r, TASK_OUTPUT_RETRY_DELAY_MS)')))
}

console.log('§44 exit heals — ?2026l first; the splash cancel disarms ?1007')
{
  const gs = read('src/utils/gracefulShutdown.ts')
  check('the fallback closes the sync bracket before the alt exit', gs.indexOf('writeSync(1, FALLBACK_CLOSE_SYNC_UPDATE)') !== -1 && gs.indexOf('writeSync(1, FALLBACK_CLOSE_SYNC_UPDATE)') < gs.indexOf('writeSync(1, FALLBACK_EXIT_ALT_SCREEN)'))
  const splash = read('assets/splash/mercury-splash.mjs')
  const cancel = splash.slice(splash.indexOf("if (OSC11_GROUND) out.write('\\x1b]111\\x07')\n    // ?1007l on the cancel exit"), splash.indexOf("screenAtExit = 'restored'"))
  check('the splash cancel disarms alternate scroll before leaving the alt buffer', cancel.includes("out.write('\\x1b[?1007l')") && cancel.includes("?1007l") && cancel.indexOf("?1007l") < cancel.indexOf("?1049l"))
  const tpl = read('scripts/release/launcherTemplates.mjs')
  const healSrc = tpl.split('\n').filter(l => l.includes('process.stdout.write(') && l.includes('?1049l'))
  check('all six launcher heal strings open with ?2026l (sh/cmd/ps1 × splash-death/abnormal-child)', healSrc.length === 6 && healSrc.every(l => l.includes('\\\\x1b[?2026l\\\\x1b[0m')))
  check('poison gone: no heal string still opens on the SGR reset alone', !healSrc.some(l => /process\.stdout\.write\(["']\\\\x1b\[0m/.test(l)))
}

console.log('§45 /help shortcuts — the rows resolve through the real registry')
{
  const tab = read('src/components/HelpV2/ShortcutsTab.tsx')
  for (const action of ['app:commandPalette', 'history:search', 'app:fileOpen', 'app:contentSearch', 'command:sessions', 'command:surfaces']) {
    check(`${action} asks the Global context`, tab.includes(`{ action: '${action}', context: 'Global',`) && !tab.includes(`{ action: '${action}', context: 'Chat',`))
  }
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
  const { parseBindings } = await import('../../src/keybindings/parser.ts')
  const { getBindingDisplayText } = await import('../../src/keybindings/resolver.ts')
  const parsed = parseBindings(DEFAULT_BINDINGS)
  const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/\s+/g, '')
  const expected: Array<[string, string]> = [['app:commandPalette', 'ctrl+x p'], ['history:search', 'ctrl+r'], ['app:fileOpen', 'ctrl+x f'], ['app:contentSearch', 'ctrl+x g'], ['command:sessions', 'ctrl+x s'], ['command:surfaces', 'ctrl+x m']]
  for (const [action, chord] of expected) {
    const shown = getBindingDisplayText(action, 'Global', parsed)
    check(`${action} resolves under Global to its default ${chord} through the real resolver`, norm(shown) === norm(chord), String(shown))
    check(`poison: ${action} resolves to NOTHING under Chat (what the old rows asked)`, getBindingDisplayText(action, 'Chat', parsed) === undefined)
  }
}

console.log("§46 /memory — the banner's r is a real key")
{
  const mv = read('src/components/memory/MemoryCentreView.tsx')
  const r = mv.indexOf("if (loadError && input === 'r' && !key.ctrl && !key.meta)")
  const q = mv.indexOf('setQuery(q => q + input)')
  check('the loadError-gated r branch exists and calls the engine reload', r !== -1 && mv.slice(r, r + 200).includes('fl.reload()'))
  check('it precedes the type-to-search append', r < q)
}

console.log('§47 git facts — the cache follows the harness ground')
{
  const gf = read('src/utils/git/gitFilesystem.ts')
  check('the reground door is exported', gf.includes('export function regroundGitWatch(): void {'))
  const door = gf.slice(gf.indexOf('export function regroundGitWatch'), gf.indexOf('function teardownWatches(): void {'))
  for (const reset of ['generation++', 'teardownWatches()', 'watcherStarted = false', 'watcherStarting = null', 'watchedGitDir = null', 'watchedCommonDir = null', 'watchedBranchRefPath = null', 'cacheEntries.clear()', 'clearResolveGitDirCache()']) {
    check(`the door resets ${reset}`, door.includes(reset))
  }
  const hg = read('src/services/switchboard/harnessGround.ts')
  check('the one ground-move door calls it after the chdir', hg.indexOf('gitFs.regroundGitWatch()') !== -1 && hg.includes('process.chdir(target)') && hg.indexOf('gitFs.regroundGitWatch()') > hg.indexOf('process.chdir(target)'))
}

process.exit(failures === 0 ? 0 : 1)
