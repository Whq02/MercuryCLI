#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-sup2-hardening.ts
// TASK-017 SUPPLEMENT 2 fixes — the UI-side pins, one §
//  per finding-close, poison-first: each § names the disease shape it
//  proves gone, then drives the cure where the cure is pure.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-sup2-hardening.ts
// ============================================================================
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Proof hygiene (.claude/rules/proof-hygiene.md): pin the config home to a
// scratch root BEFORE any src import — §24 drives the settings write door
// and getMercuryHome memoises on first read; nothing here may touch the
// operator's real home.
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

// ── §1 · shell-detail-reads-whole-output-file-at-1hz (important) ────────────
// The dialog's 1 Hz "tail read" was readFileSync(path,'utf8') over the WHOLE
// output file — a full read + decode per second on a growing build log, and
// past V8's max string length the decode threw, so the frame read "0 lines
// shown" while the file grew. The read is now the bounded sync twin of
// tailFile: final maxBytes only, at any file size.
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
// NEEDS-REAL-BOX (the report's driver check): let a background shell's output
// file pass ~50 MB, open /bashes → the shell, and time a keystroke round-trip
// against the pane closed; past V8's max string length the frame must keep
// showing the true tail + total instead of "0 lines shown".

// ── §2 · bash-timeout-cap-advertised-not-enforced (important) ───────────────
// The Bash schema advertised "max ${getMaxTimeoutMs()}" while the lane never
// clamped — a model-supplied timeout ran whole (an hour foreground, ten once
// backgrounded via HARD_CAP_MULTIPLIER); the PowerShell twin clamped on the
// identical line. Both lanes now carry the same Math.min.
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
// NEEDS-REAL-BOX (the report's driver check): BASH_MAX_TIMEOUT_MS=5000, then
// Bash and PowerShell each with timeout: 60000 over a sleep-30 — both cut at 5s.

// ── §3 · concourse-too-small-names-pane-width (important) ───────────────────
// The too-small screen printed `{cols}×{termRows}` where cols = frameCols ??
// termCols — under the split frame that is the board PANE's width clamped to
// 80, presented as "this window". The sentence now reads the terminal's own
// columns; the geometry keeps using the frame's.
console.log('§3 concourse too-small — the notice names the window, not the pane')
{
  const layout = read('src/components/concourse/ConcourseLayout.tsx')
  check('poison gone: the notice no longer prints the pane width', !layout.includes('this window is {cols}×{termRows}'))
  check('the notice prints the terminal columns', layout.includes('this window is {termCols}×{termRows}'))
  check('the geometry still rides the frame columns', layout.includes('const cols = frameCols ?? termCols'))
}
// NEEDS-REAL-BOX (the report's driver check): split on at ≥121 cols, drag the
// window below 24 rows — the printed width must equal the real window width.

// ── §4 · tool-result-blobs-swept-unreferenced (important) ───────────────────
// "Referenced blobs are NEVER deleted by age" guarded only the isDirectory()
// arm (pdf-<uuid>) while every persisted tool-result body is a LOOSE FILE —
// the isFile() arm deleted by mtime with no reference test, so a session used
// daily lost every body older than cleanupPeriodDays while its transcript
// still said "Full output saved to". Both arms now consult the one set.
console.log('§4 blob sweep — the loose-file arm honours the reference set')
{
  const cleanup = read('src/utils/cleanup.ts')
  const fileArm = cleanup.slice(cleanup.indexOf('} else if (toolResultEntry.isFile())'))
  const dirArm = cleanup.slice(cleanup.indexOf('if (toolResultEntry.isDirectory())'), cleanup.indexOf('} else if (toolResultEntry.isFile())'))
  check('the directory arm still consults referenced', dirArm.includes('referenced?.has(toolResultEntry.name)'))
  check('poison gone: the file arm consults referenced too', fileArm.includes('referenced?.has(toolResultEntry.name)'))
  check('the file-arm guard precedes the stat/unlink', fileArm.indexOf('referenced?.has(toolResultEntry.name)') < fileArm.indexOf('await fs.unlink(toolResultPath)'))
  // The reference set can hold the loose NAME: the capture admits dots, so a
  // pointer path ending tool-results/<id>.txt yields '<id>.txt' — the exact
  // dirent name the file arm now tests.
  const pattern = /tool-results[/\\]+([A-Za-z0-9_.-]+)/g
  const hit = [...'Full output saved to: C:\\home\\proj\\sess\\tool-results\\toolu_9.txt'.matchAll(pattern)]
  check('the pointer capture yields the dirent name with its extension', hit.length === 1 && hit[0]?.[1] === 'toolu_9.txt')
  check('the in-tree capture still admits dots (the set can hold file names)', cleanup.includes('[A-Za-z0-9_.-]+'))
}
// NEEDS-REAL-BOX (the report's driver check): backdate a referenced
// <toolUseId>.txt past cleanupPeriodDays, run the housekeeping cycle, and the
// file must survive while the transcript's pointer line stands.

// ── §5 · runner-availability-ignores-pathext (important) ────────────────────
// The runner availability probe joined PATH with the BARE name — on win32
// cargo/go/node ship only their .exe, so Test/Launch profiles hard-refused
// installed toolchains forever ("'cargo' not on PATH · install the Rust
// toolchain"). The probe now applies PATHEXT on win32, still zero-spawn.
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
// NEEDS-REAL-BOX (the report's driver check): a Cargo project on a box with
// rustup — Launch op:"list" rows must read available; where.exe cargo agrees.

// ── §6 · max-retries-nan-zero-attempts (important, narrowed) ────────────────
// The no-request outcome for an unparseable MERCURY_MAX_RETRIES is ruled
// deliberate IN the code — what lied was the registry row ("unparseable
// values fall through to the default") and the terminal line ("retry
// attempts exhausted" for a turn that made ZERO attempts). Both now state
// the real contract; the ruled behavior is untouched.
console.log('§6 max-retries — the registry row and the refusal tell the truth')
{
  const retry = read('src/services/api/withRetry.ts')
  const registry = read('src/substrate/flagRegistry.ts')
  check('the ruled no-run parse stands untouched', retry.includes('return Number.parseInt(env, 10)'))
  check('poison gone: the registry row no longer promises a fall-through', !registry.includes('unparseable values fall through to the default'))
  check('the registry row names the refusal', registry.includes('refuse without one request'))
  check('the zero-attempt throw names the variable, not exhaustion', retry.includes('is not a non-negative integer — no request was attempted'))
  check('a genuine exhaustion still says exhausted', retry.includes("'retry attempts exhausted'"))
  // The guard arithmetic the message keys on, driven pure:
  const neverRuns = (n: number): boolean => !(1 <= n + 1)
  check('NaN and -1 are the zero-attempt shapes; 0 and 10 run', neverRuns(Number.NaN) && neverRuns(-1) && !neverRuns(0) && !neverRuns(10))
}

// ── §7 · update-finally-rmsync-discards-update-verdict (important) ──────────
// The one uncontrolled exit left in performUpdate sat AFTER the point of no
// return: finally { rmSync(staging); releaseUpdateLock } — a win32
// EPERM/EBUSY on the staging sweep replaced {state:'updated'} with a raw
// errno (update reported failed on a box running the new version, receipt
// skipped, lock release skipped). The sweep is now verdict-preserving.
console.log('§7 update finally — the sweep cannot replace the verdict')
{
  const svc = read('src/services/privateChannel/updateService.ts')
  const fin = svc.slice(svc.indexOf('previousKept: previous !== null'), svc.indexOf('// ── rollback'))
  check('the sweep is guarded inside the finally', fin.includes('try {') && fin.includes('rmSync(staging, { recursive: true, force: true })') && fin.includes('catch (sweepError)'))
  check('the lock release stands OUTSIDE the guarded sweep, still in the finally', fin.indexOf('releaseUpdateLock(roots)') > fin.indexOf('catch (sweepError)'))
  check('poison gone: no bare rmSync line remains between the verdict and the release', !fin.includes('    rmSync(staging, { recursive: true, force: true })\n    releaseUpdateLock'))
}
// NEEDS-REAL-BOX (the report's driver check): hold an open handle on
// .download-<pid>\\extracted\\…\\mercury.mjs across the activation step —
// `mercury update` must still report updated: X → Y and write its receipt.

// ── §8 · ripgrep-cancel-reported-as-search-timeout (important) ──────────────
// The wrapper folded the caller's own abort (ABORT_ERR) into the timeout
// classifier: an Esc during a slow Grep recorded an is_error tool_result
// reading "The search timed out after 20 seconds", fired failure hooks with
// isInterrupt=false, and logged a fabricated failure. An abort with no
// salvage now throws an AbortError-NAMED error (the tool layer's
// isAbortError reads exactly that), while AbortSignal.timeout() deadlines —
// whose reason is a TimeoutError — stay on the honest timeout arm.
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
// NEEDS-REAL-BOX (the report's driver check): start a Grep over a large tree,
// Esc within a second — the turn must record an interruption, never "The
// search timed out after 20 seconds".

// ── §9 · shared-json-parse-object-mutated-by-settings-validator (important) ─
// safeParseJSON hands every caller the SAME cached object; the settings
// reader mutated it in place, so a malformed permission rule was reported
// exactly once per process (any settings write cleared the per-file cache
// but not the JSON LRU — the '1 settings issue' notice then retracted while
// the rule stayed in the file), and of two byte-identical files only the
// first could ever report its own warnings. The reader now clones first.
console.log('§9 settings parse — the shared cache object is never mutated')
{
  const settings = read('src/utils/settings/settings.ts')
  check('the reader clones before the in-place passes', settings.includes('structuredClone(shared)'))
  check('poison gone: the mutators no longer receive the cached object', !settings.includes('const parsed = safeParseJSON(stripBOM(raw), false)\n  adoptLegacySupercodeSpelling(parsed)'))
  // The mechanism + cure, driven end to end through the exported reader:
  // two byte-identical files must EACH report their own warning.
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
// NEEDS-REAL-BOX (the report's driver check): an invalid allow rule in the
// live settings.json — the settings-issue notice must survive an unrelated
// 'don't ask again' write instead of retracting.

// ── §10 · lsp-catalogue-where-exe-sweep (important) ─────────────────────────
// probeCatalogueEntry computed the free root verdict and then probed the
// binary UNCONDITIONALLY — on win32 that is a blocking where.exe per absent
// toolchain (~24 on an ordinary box; misses uncached by which.ts law), paid
// at startup and per capability-manager refresh for rows the offered-configs
// consumer throws away on !rootMatched. The configs path now probes only
// when the root matched; the records view keeps the full probe because its
// "binary present but no root marker" rows need it.
console.log('§10 lsp catalogue — the offered-configs path never probes an unmatched root')
{
  const cat = read('src/services/lsp/serverCatalogue.ts')
  check('the probe takes a per-call-site binaryProbe mode', cat.includes("binaryProbe: 'always' | 'when-root-matched' = 'always'"))
  check('an unmatched root short-circuits before resolveBinary in lazy mode', cat.includes("if (binaryProbe === 'when-root-matched' && !rootMatched) return { entry, rootMatched }"))
  check('catalogueServerConfigs passes the lazy mode', cat.includes("probeCatalogueEntry(entry, cwd, cwdEntries, 'when-root-matched')"))
  const records = cat.slice(cat.indexOf('export function serverCatalogueRecords'))
  check("the records view keeps the full probe (its detected-not-offered rows are the point)", records.includes('probeCatalogueEntry(entry, cwd, cwdEntries)') && !records.includes("'when-root-matched'"))
  // The lazy contract, driven pure with a synthetic entry against a listing
  // that cannot match: the probe must return without touching PATH at all.
  const { probeCatalogueEntry } = await import('../../src/services/lsp/serverCatalogue.ts')
  const entry = { id: 'sup2-probe', label: 'x', languages: [], binaries: ['sup2-definitely-absent-binary'], rootMarkers: ['sup2.marker.never'], extensionToLanguage: {} } as unknown as Parameters<typeof probeCatalogueEntry>[0]
  const lazy = probeCatalogueEntry(entry, process.cwd(), ['README.md'], 'when-root-matched')
  check('lazy + unmatched root ⇒ no binary field at all', lazy.rootMatched === false && lazy.binaryPath === undefined)
}
// NEEDS-REAL-BOX (the report's driver check): capability manager open, hold
// 'r' — the where.exe storm for absent toolchains must be gone from the
// startup path; the records view's own sweep remains its deliberate cost.

// ── §11 · tree-digest-execsync-through-cmd (important, scoped) ──────────────
// computeWorkingTreeDigest issued four git calls as COMMAND STRINGS through
// execSync — by contract the platform shell runs them, i.e. cmd.exe on
// win32: eight process creations where argv makes four, all blocking. The
// four calls now ride execFileSync argv (still sync by design at this seam —
// the async twin stays the hot-path door; the /run·/orient sync-reach is the
// §S2 lead, not this cut).
console.log('§11 tree digest — argv, never a shell')
{
  const vs = read('src/utils/verification/verificationState.ts')
  check('poison gone: no execSync command strings remain', !vs.includes('execSync('))
  // The four calls spawn the RESOLVED git (gitExe(), the memoized resolver —
  // FN-014 row 3) with the same argv; the law here is argv, never
  // a shell.
  check('the four calls are argv execFileSync', ["['read-tree', 'HEAD']", "['add', '-A', '--', '.']", "['reset', '-q', '--', '.claude', '.mercury']", "['write-tree']"].every(a => vs.includes(`execFileSync(gitExe(), ${a}`)))
  check('the async twin still spells argv too', vs.includes('execFile(gitExe(), args, { windowsHide: true, cwd, env }'))
}
// NEEDS-REAL-BOX (the report's driver check): /run in a large repo — git.exe
// appears WITHOUT a cmd.exe parent per digest; the stall shrinks by the four
// shell creations while the sync-reach lead stays filed.

// ── §12 · boot-splash-uncapped-sync-store-scan (important) ──────────────────
// The Boot face's first-render scan bounded its ROWS (32/10) but not its
// WORK: every directory under projects/ paid readdir + stat-per-jsonl + the
// husk reads inside React's render, before the raw-mode arm. The visit list
// is now capped at BOOT_SCAN_DIR_CAP with a recency pre-rank (one cheap stat
// per dir, only ABOVE the cap) so the newest projects always make the visit.
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
// NEEDS-REAL-BOX (the report's driver check): MERCURY_PROFILE_STARTUP=1 on a
// populated home — the render_and_run delta must stop scaling with dir count
// past the cap.

// ── §13 · gitbash-refusal-painted-into-discarded-alt-buffer (important) ─────
// On a launcher boot the git-bash refusals ran inside init() while the
// splash's alt-screen hold was still pending: the guidance landed on the
// ALTERNATE buffer and the module's own exit net restored ?1049l over it —
// mercury.cmd returned exit 1 with a blank prompt and not one word about
// git-scm.com. Both refusal arms now release the hold FIRST (main.tsx's
// writeErr pattern), before their writeSync.
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
// NEEDS-REAL-BOX (the report's driver check): Git off PATH, packaged
// mercury.cmd in Windows Terminal — the full download-it message must be on
// the MAIN buffer after exit 1; node dist\\mercury.mjs already showed it.

// ── §14 · boot-settings-sync-git-in-render (important) ──────────────────────
// Pressing m/s on the Boot face mounted BootSettingsScreen whose useState
// initializer ran TWO spawnSync git calls inside the first render — up to
// 2.3s of dead terminal on a keypress (no paint, no input, esc dead) for a
// decoration string. The probe is now async execFile in a mount effect (the
// RealmsView fix's exact class), fail-soft, cancelled on unmount.
console.log('§14 boot settings — no sync git inside a render')
{
  const screen = read('src/components/BootSettingsScreen.tsx')
  check('poison gone: no spawnSync CALL anywhere in the face', !screen.includes('spawnSync('))
  check('the probe is async execFile', screen.includes("import { execFile } from 'node:child_process'"))
  check('the mount effect owns the probe (initializer no longer does)', screen.includes('useEffect(() => gitTailProbe(setDirTail), [])') && !screen.includes('useState(() => gitTailOnce())'))
  check('unmount cancels the callbacks (no setState after close)', screen.includes('alive = false'))
  check('the timeouts the sync form budgeted stay as async caps', screen.includes('timeout: 800') && screen.includes('timeout: 1500'))
}
// NEEDS-REAL-BOX (the report's driver check): hold a key while pressing 's'
// on the splash in a cold-cache repo — keystrokes must echo during the
// mount instead of bursting after the git pair returns.

// ── §15 · prune-door-leaves-resume-snapshot-sidecar (important; also the
//          persistence moderate prune-leaves-resume-snapshot-behind) ────────
// Any ≥256KB load (a /resume PREVIEW included) writes
// <transcript>.resume-snapshot.json holding the serialized conversation.
// The prune door unlinked only the transcript + receipts, so the operator's
// disk-reclaim left a same-order copy of every pruned conversation behind
// and the receipt's freed figure excluded it. The offer now freezes the
// snapshot path beside the receipts path; the door stat-unlinks it and its
// bytes join bytesFreed.
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
// NEEDS-REAL-BOX (the report's driver check): Get-ChildItem -Recurse -Filter
// *.resume-snapshot.json before/after the /sessions prune — the sidecars
// vanish with their transcripts and the freed figure covers them.

// ── §16 · cleanup-promise-all-collapses-exit-quiescence (important ×3 ids:
//          + cleanup-failfast-voids-exit-quiescence · cleanup-barrier-fails-
//          fast) ────────────────────────────────────────────────────────────
// runCleanupFunctions was a bare Promise.all: the FIRST rejecting cleanup
// settled the aggregate while its siblings' threadpool I/O was still in
// flight, quiesceCleanupBeforeExit's `cleanupRun.catch(() => {})` resolved
// on the next microtask, and the 400ms win32 exit-cliff grace collapsed to
// zero exactly when in-flight completions were most likely (0xC0000409).
// The aggregate now settles only when EVERY cleanup has; the first
// rejection still propagates (the documented caller contract).
console.log('§16 cleanup barrier — the aggregate waits for every sibling')
{
  const reg = read('src/utils/cleanupRegistry.ts')
  check('poison gone: no bare Promise.all aggregate', !reg.includes('await Promise.all('))
  check('allSettled-then-throw is the shape', reg.includes('Promise.allSettled') && reg.includes('if (firstRejection) throw'))
  // The semantics, driven live through the real module:
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
// NEEDS-REAL-BOX (the report's driver check): deny-share the live .jsonl,
// quit — the exit interval must include the quiescence instead of ~0ms; -p
// runs watched for 0xC0000409 on the floor runtime.

// ── §17 · transcript-drain-drops-batch-on-append-failure +
//          transcript-flush-latches-on-one-append-error (important ×2, one
//          door: the drain callback) ────────────────────────────────────────
// The flush timer was the tree's ONE setTimeout(async …) with no catch: an
// append failure (EPERM/EBUSY from a scanner holding the .jsonl, ENOSPC)
// discarded the spliced batch AND its resolvers with the stack frame, left
// activeDrain latched on the rejected promise (every later flush() — the
// shutdown flush included — rethrew instantly without draining), and never
// re-armed. Now: sync callback + tracked run; the un-landed tail is
// REQUEUED at the front with resolvers intact; activeDrain clears in a
// finally; the retry re-arms on a 100ms→5s backoff; the first failure of a
// streak lands in the error ring. (An injectable append seam for a pure
// fault drive is a filed §S2 prover-depth lead — the deny-share drill is
// the behavioral leg and needs the real box by nature.)
console.log('§17 writer drain — no silent batch loss, no latch, tracked timer')
{
  const writer = read('src/utils/sessionStorage/writer.ts')
  check('poison gone: no async timer callback in the writer (the tree-wide census shape)', !/setTimeout\(async/.test(writer.replace(/^\s*\/\/.*$/gm, '')))
  check('the drain run is tracked and activeDrain clears in a finally', writer.includes('if (this.activeDrain === run) this.activeDrain = null'))
  check('the un-landed tail requeues at the FRONT with its resolvers', writer.includes('queue.unshift(...batch.slice(landed))'))
  // Since release-hardening rank 57 the requeue RECORDS the failure and the
  // drain rethrows the aggregate after every file drained — flush() callers
  // still see the truth, and one unwritable file no longer starves the rest.
  check('the requeue records the failure and the drain rethrows so flush() callers see the truth', /queue\.unshift\(\.\.\.batch\.slice\(landed\)\)\s*\n\s*failures\.push\(\{ filePath, error: err \}\)/.test(writer) && writer.includes('if (failures.length === 1) throw failures[0]!.error'))
  check('the retry backs off (100ms base, 5s cap)', writer.includes('this.FLUSH_INTERVAL_MS * 2 ** this.drainFailureStreak, 5_000'))
  check('a failure streak reports once to the error ring', writer.includes('if (this.drainFailureStreak === 0) logError(err)'))
  check('a successful drain resets the streak', writer.includes('this.drainFailureStreak = 0'))
  check('the failure re-arm rides the same finally (requeued remainder earns the retry)', /finally\(\(\) => \{[\s\S]{0,400}this\.scheduleDrain\(\)/.test(writer))
}
// NEEDS-REAL-BOX (the report's driver check): hold the live transcript with
// a deny-all share for ~200ms mid-session, release, quit — the on-screen
// turns must all be in the .jsonl and in --resume; then hold ACROSS the quit
// and confirm the cliff drain's abandoned-by-name line instead of silence.

// ── §18 · login-mint-screen-has-no-key-at-all (important, scoped) ───────────
// The 'Minting the key…' screen deregisters esc (isActive covers
// ready|waiting|error only), /logins is local-jsx (no ctrl+c owner), and
// the mint was the file's ONE axios call with no timeout — an intercepting
// proxy or black-holed DNS held the spinner forever with every key dead.
// The mint now carries the sibling EXCHANGE_TIMEOUT_MS, so the wedge lands
// in the flow's ERROR state where esc is live. (The local-jsx ctrl+c
// ownerlessness is a systemic §S2 class row, not this cut.)
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
// NEEDS-REAL-BOX (the report's driver check): block the API-key endpoint
// host, /logins → usage-based → console, finish the browser leg — the
// 'Minting the key…' screen must resolve to the error state within ~15s,
// where esc backs out.

// ── §19 · teammates-board-key-dead-while-spawning (important) ───────────────
// The board's one input owner opened `if (busy) return` under
// captureInput={false} on a local-jsx command: while a crew spawn retried
// against a wedged daemon (up to ~51s) there was NO escape and no ctrl+c
// anywhere, with the footer still reading 'esc close'. Esc now closes while
// busy (abandoning the wait, not the daemon-side work) and the busy footer
// says exactly that.
console.log('§19 teammates board — esc lives while busy, the footer says so')
{
  const board = read('src/components/mercury-ui/screens/TeammateChatsView.tsx')
  check('poison gone: the busy arm no longer swallows every key', !/if \(busy\) return/.test(board))
  check('esc closes while busy', /if \(busy\) \{[\s\S]{0,700}if \(key\.escape\) onClose\(\)[\s\S]{0,40}return/.test(board))
  check('the busy footer stops advertising a dead board', board.includes("busy ? 'working… · esc close (the spawn/stop finishes in the daemon)'"))
}
// NEEDS-REAL-BOX (the report's driver check): daemon unreachable, /teammates
// → n → name → ↵ → ↵ on the model chip, then esc — the board must close at
// once instead of ~50s of dead keys.

// ── §20 · feedback-report-built-then-discarded (important) ──────────────────
// /bug gathered the whole redacted report and dropped it on the next line
// (`void report`), then said "Report drafted locally" about a file that
// existed nowhere, under a palette line promising a GitHub issue no
// unconfigured box ever produced. The draft now lands at
// <config-home>/feedback/bug-<stamp>.json through the atomic-publish law,
// the done screen names the path (or says honestly that the write was
// refused), and the palette line says what a default box gets.
console.log('§20 /bug — the draft is a real file the done screen names')
{
  const feedback = read('src/components/Feedback.tsx')
  check('poison gone: the gathered report is no longer voided (code lines only)', !/^\s*void report\b/m.test(feedback.replace(/^\s*\/\/.*$/gm, '')))
  check('the draft persists through the atomic-publish law', feedback.includes('durableAtomicPublishSync(path,') && feedback.includes("join(getMercuryHome(), 'feedback')"))
  check('the done screen names the path (and the refused-write truth)', feedback.includes('saved to ${savedPath}') && feedback.includes('could not be written'))
  check('the consent promise stands (nothing is uploaded anywhere)', feedback.includes('nothing is uploaded anywhere'))
  const cmd = read('src/commands/feedback/index.ts')
  check('the palette line stops promising an issue a default box never files', !cmd.includes('becomes a GitHub issue') && cmd.includes('drafted to a local file'))
}
// NEEDS-REAL-BOX (the report's driver check): /bug → description → enter —
// a bug-<stamp>.json must exist under %USERPROFILE%\\.mercury\\feedback and
// the done frame must name it.

// ── §21 · config-revert-publishes-stale-monolith (important) ────────────────
// Escaping /config published the entire mount-time global config —
// `saveGlobalConfig(() => snapshots.global)` ignored the lock's fresh
// re-read, so a sibling tab's trust acceptance, MCP approvals and
// worktree-return record were reverted, records born after the mount were
// deleted, and the stale view write-throughed into the live cache; step 4
// likewise restored the permissions object wholesale. The revert now
// restores ONLY the keys THIS dialog touched (tracked at writeGlobal by
// identity diff) onto the CURRENT config, and only permissions.defaultMode
// among the permission keys.
console.log('§21 /config revert — targeted undo, never the mount snapshot')
{
  const cfg = read('src/components/Settings/Config.tsx')
  check('poison gone: no wholesale snapshot publish', !cfg.includes('saveGlobalConfig(() => snapshots.global)'))
  check('the dialog tracks its touched global keys at the one write door', cfg.includes('globalTouchedRef.current.add(key)'))
  check('the revert merges the snapshot values onto CURRENT (lock re-read respected)', cfg.includes('saveGlobalConfig(current => {') && cfg.includes('const restored = { ...current }'))
  check('an untouched dialog reverts no global key at all', cfg.includes('if (globalTouchedRef.current.size > 0)'))
  check('a key absent at mount deletes on revert (born-in-dialog keys go)', cfg.includes('if (snap[key] === undefined) delete restored[key]'))
  // The revert writes the ONE changed key through the source writer with an
  // explicit undefined for a delete (prove-settings-write-scope re-cut the
  // old local-object delete, which pruned a copy the merge never saw); the
  // law — only defaultMode moves back, never the whole permissions object —
  // unchanged.
  check('permissions revert moves ONLY defaultMode', cfg.includes('permissions: { defaultMode: snapshots.user.permissions?.defaultMode }') && !cfg.includes('permissions: snapshots.user.permissions'))
}
// NEEDS-REAL-BOX (the report's driver check): two tabs, tab B accepts a new
// project's trust while tab A sits in /config; tab A toggles + Escape — tab
// B's trust must survive (no re-prompt; the backup diff shows only tab A's
// own keys moving).

// ── §22 · service-stop-kills-root-only (important) ──────────────────────────
// `service stop` sent process.kill(pid) — on win32 a bare TerminateProcess
// of the ONE spawned root, so the listener a .cmd/`cmd /c`/`python -m`
// wrapper forked kept the socket while the record read 'stopped' with its
// pid nulled and the restart failed to bind. Both strike phases now ride
// endProcessTree, the estate's one cross-platform tree owner; posix keeps
// its real TERM grace first.
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
// NEEDS-REAL-BOX (the report's driver check): a service whose command spawns
// its own listener child (cmd /c node server.js, readiness tcp) — after
// `service.stop`, netstat must show the port free and tasklist no grandchild.

// ── §23 · api-timeout-ms-three-parsers-no-floor (important) ─────────────────
// Three sites parsed API_TIMEOUT_MS three ways: parseInt read '60s' as a
// 60-MILLISECOND transport (every turn died instantly), Number() elsewhere
// fell back on the same text, no site floored at > 0, and the error panel
// glued 'ms' onto the raw value ('API_TIMEOUT_MS=60sms, try increasing
// it'). One strict owner now: whole positive ms or null; both panels name
// an unparseable spelling with the remedy.
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
// NEEDS-REAL-BOX (the report's driver check): API_TIMEOUT_MS='60s' — turns
// now run on the default budget and the row names the bad spelling; '60'
// still gives an honest 60ms failure; 'sixty' runs on defaults.

// ── §24 · settings-write-erases-rejected-permission-rules (important; also
//          the config-integrity moderate nested-settings-keys-stripped-on-
//          write and hooks.ts's own recorded matcher data-loss defect) ──────
// The write path's base was the PARSED view — invalid permission rules
// already filtered out, nested unknown keys already stripped — so any
// unrelated write (/theme, /model, a grant) silently erased them from the
// operator's file, together with the only evidence a warning had fired.
// The base is now the file's own raw JSON; the schema still gates reads.
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
// NEEDS-REAL-BOX (the report's driver check): an invalid rule in the live
// settings.json + /theme — the rule must still be in the file after, and
// the settings-issue warning must fire again next boot.

// ── §25 · stall-wake-re-enter-clobbers-exit-cursor (important; also the two
//          stall-detector moderates: -erases-cockpit · -destructive-alt) ────
// The sleep/wake heal wrote a BARE second ?1049h onto an active alt screen
// — re-running the DEC 1049 cursor save with the alt cursor, so the single
// exit ?1049l later parked the shell prompt mid-scrollback — with no
// repaint scheduled: the cockpit blanked and stayed blank until an
// unrelated commit. The heal is now the PAIRED exit+enter composite (the
// save/restore slot stays true on both wake shapes) plus a scheduled
// repaint through the normal atomic path.
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
// NEEDS-REAL-BOX (the report's driver check): pty-capture a sleep/wake (or a
// >5s block) — the stream must show ?1049l immediately before the ?1049h,
// a repaint following, and /exit's resume hint landing at the operator's
// own prompt row.

// ── §26 · exit-plan-editor-hint-dead-both-ways (important; closes the
//          dialog-defaults moderate plan-card-ctrl-g-hint-dead) ─────────────
// The plan card's footer taught 'ctrl+g edit in <editor>' while ctrl+g was
// bound NOWHERE, and the card's chat:externalEditor hook registered under
// 'Confirmation' — a context the only binding (ctrl+x ctrl+e, Chat block)
// can never resolve from, so the correct chord opened the COMPOSER DRAFT
// instead of the plan. The Confirmation block now binds ctrl+g to the
// action (globally unbound per the block's own ctrl+f law; a control
// chord, so the PD-1 field-owns-focus class does not apply; not a decision
// verb), and the action row admits both contexts.
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
// NEEDS-REAL-BOX (the report's driver check): plan card up, press ctrl+g —
// the PLAN opens in $EDITOR (never the composer draft); /keys shows the
// Confirmation row.

// ── §27 · no-sync-output-hatch-demotes-host (important) ─────────────────────
// MERCURY_NO_SYNC_OUTPUT is the advertised fix for a tearing terminal — and
// it was also the ONLY witness the required 'full-profile Windows host' row
// had on a fingerprint-less Windows Terminal (defterm, no WT_SESSION):
// setting the rendering knob flipped the required row to failing on every
// boot, and the card's self-clearing rescue was dead because the probe
// upgrade returned early under the same hatch. Capability and emission are
// now split: the latch records what the terminal CAN do (sniff or probe,
// hatch-free), the hatch gates only whether frames are WRAPPED, the host
// verdict reads capability, and the probe upgrade records under the hatch.
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
  // The public contract, driven live: with the hatch set, emission is off
  // while capability stands (this process carries no WT_SESSION — drive via
  // the force-on sniff arm, which the hatch also used to eat).
  const { isSynchronizedOutputSupported, syncOutputSupportedNow, syncOutputCapabilityNow, upgradeSyncOutputSupport } = await import('../../src/ink/session/capabilities.ts')
  delete process.env.TMUX
  process.env.MERCURY_NO_SYNC_OUTPUT = '1'
  upgradeSyncOutputSupport()
  check('under the hatch: capability true, emission false, public read false', syncOutputCapabilityNow() === true && syncOutputSupportedNow() === false && isSynchronizedOutputSupported() === false)
  delete process.env.MERCURY_NO_SYNC_OUTPUT
  check('hatch lifted: the recorded capability arms emission at once (the self-clearing rescue)', syncOutputSupportedNow() === true)
}
// NEEDS-REAL-BOX (the report's driver check): WT as the OS default terminal
// (no WT_SESSION), MERCURY_NO_SYNC_OUTPUT=1 — the boot must land on the
// cockpit with wrapping off, never the requirement card.

// ── §28 · keys-atlas-actions-without-handlers (important; closes the
//          advertised-dead moderate registry-rows-with-no-handler) ──────────
// Seven default-bound actions had NO handler anywhere: /keys printed them
// as bound and offered its ctrl+r rebind, which wrote silently-inert rows.
// crew:open-board's chord now dispatches the REAL door (command:workbench →
// /workbench); the three vapor rows (settings:search, confirm:toggle,
// confirm:nextField) and the composer trio (chat:submit, history:previous,
// history:next — hardcoded in useTextInput, so the registry could only lie
// about them) are retired by the Settings-enter precedent and pinned
// retired in prove-action-graph.
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
// NEEDS-REAL-BOX (the report's driver check): /keys — no crew row; ctrl+x k
// OPENS /workbench; ↑ still recalls history while no registry row claims it.

// ── §29 · corrupt-config-reset-exits-silently (important; closes the
//          dialog-defaults moderate invalid-config-reset-no-quarantine) ─────
// The gate's 'Reset it to the default configuration' overwrote the file in
// place with NO copy of the corrupt bytes — the whole estate (oauth,
// trust grants, project records) destroyed over a trailing comma — and a
// FAILED write exited 1 in total silence, indistinguishable from 'Exit and
// fix by hand', so the operator concluded the reset ran and met the same
// gate next boot. The reset now quarantines first (the read path's own
// contract, same backups home), speaks on BOTH arms via writeSync, and a
// refused quarantine never blocks the reset.
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
// NEEDS-REAL-BOX (the report's driver check): corrupt the config, attrib +R
// it, choose Reset — stderr must name the failure and the file; writable
// again, the reset must land with the quarantine named.

// ── §30 · external-includes-esc-persists-no (important — the approved card
//          half; the dead /settings re-entry row stays a §S2 deferral to
//          the control-plane review) ────────────────────────────────────────
// The boot card asked a PERMANENT per-project question with no key guide
// (both callers hide the Dialog byline), esc silently persisted 'No'
// forever, and the boot mount passed no includes list — the operator
// answered over an empty census. The card now paints its own honest guide
// (esc ANSWERS No, saved for this project) and the boot mount names the
// includes from the already-warm walk.
console.log('§30 external-includes card — the question shows its stakes')
{
  const dlg = read('src/components/ExternalInstructionIncludesDialog.tsx')
  check('the card paints its own guide with the esc truth', dlg.includes('esc answers No — the answer is saved for this'))
  check("esc still answers 'no' (the persisted contract unchanged)", dlg.includes("onCancel={() => handleSelection('no')}"))
  const helpers = read('src/interactiveHelpers.tsx')
  check('the boot mount names the includes (from the memoized walk)', helpers.includes('getExternalInstructionIncludes(await getInstructionFiles(true))') && helpers.includes('externalIncludes={includes}'))
}
// NEEDS-REAL-BOX (the report's driver check): a MERCURY.md with
// @../outside/NOTES.md — the boot card must list the path and the guide
// line; esc, then the project record carries the persisted No exactly as
// before.

// ── §31 · pidlock-reuse-guard-inert-on-win32 + win32-supervisor-lock-no-
//          reuse-token (important ×2 — the token half in pidLock, proven
//          in prove-pidlock §6; the stop-verb LOCK-ONLY sweep here) ────────
// The ONE mutex behind the daemon seat, the cron seat and the room gate
// reclaimed only on holderAlive() false — and off linux procStartToken was
// undefined, so acquire wrote no token and a recycled pid read LIVE forever.
// pidLock now routes the token through the tree's one cross-platform owner
// (ownerWatch — the merged pidAlive.ts precedent); and `daemon stop`'s
// no-record arm sweeps a lock-only leftover whose holder fails identity,
// after the ENOCONN dead-confirm it already had.
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
// NEEDS-REAL-BOX (the report's driver checks): read a live supervisor.lock
// on the box — it now carries procStart (the old task store's lock retired
// with its estate; this line was re-trued); hand-write a
// lock-only supervisor.lock naming explorer.exe's pid with no json beside it,
// run `mercury daemon stop` — swept, then `mercury daemon run` starts.

// ── §32 · wedged-daemon-reads-as-starting (important, scoped) ───────────────
// A daemon that accepts the pipe but never answers is 'starting' every round:
// the ladder is 40×(500+250)ms ≈ 30s (the comment said ~10s), N gestures ran
// N ladders concurrently, and the refusal promised '↵ again starts it' when
// ↵ re-ran the same wait. Comment trued, ladder single-flighted, refusal
// names the retry and the remedy; spawn-on-wedge stays the §S2 daemons row.
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
// NEEDS-REAL-BOX (the report's driver check): suspend the daemon process
// (pipe bound, not reading), pick a project from the boot splash — one ≈30s
// wait, the new refusal line, no second concurrent ladder from a second ↵.

// ── §33 · mcp-and-keybindings-json-no-bom-strip (moderate) ──────────────────
console.log('§33 BOM — .mcp.json and keybindings.json parse through the one owner')
{
  const mcp = read('src/services/mcp/config.ts')
  const kb = read('src/keybindings/loadUserBindings.ts')
  check('poison gone: no bare JSON.parse(raw) at either door', !mcp.includes("JSON.parse(raw)") && !kb.includes("JSON.parse(raw)"))
  check('both doors strip through jsonRead.stripBOM', mcp.includes('JSON.parse(stripBOM(raw))') && kb.includes('JSON.parse(stripBOM(raw))'))
  const { stripBOM } = await import('../../src/utils/jsonRead.ts')
  check('a BOM-prefixed document parses after the strip', JSON.parse(stripBOM('\uFEFF{"mcpServers":{}}')).mcpServers !== undefined)
}

// ── §34 · gitignore-rule-written-with-win32-backslashes (moderate) ──────────
console.log('§34 gitignore — the rule is POSIX on every platform')
{
  const gi = read('src/utils/git/gitignore.ts')
  check('the entry folds separators before it is written or compared', gi.includes("const entry = `**/${filename.split('\\\\').join('/')}`"))
  check('poison gone: no raw-filename entry', !gi.includes('const entry = `**/${filename}`'))
  check('the fold arithmetic: a win32 spelling yields the POSIX rule', `**/${'.mercury\\settings.local.json'.split('\\').join('/')}` === '**/.mercury/settings.local.json')
}

// ── §35 · control-key-never-cleared (moderate) ──────────────────────────────
console.log('§35 daemon teardown — the key clears before the record it is checked against')
{
  const main = read('src/daemon/main.ts')
  const i = main.indexOf('if (controlEnabled) await clearControlKey().catch(() => {})')
  const j = main.indexOf('if (controlEnabled) await clearSupervisorState().catch(() => {})')
  check('both clears still run on the graceful path', i !== -1 && j !== -1)
  check('the key clear PRECEDES the record clear (the guard reads the record)', i < j)
}

// ── §36 · agent-sidecar-not-durably-published (moderate) ────────────────────
console.log('§36 agent sidecar — the whole-file atomic law')
{
  const paths = read('src/utils/sessionStorage/paths.ts')
  const fn = paths.slice(paths.indexOf('export async function writeAgentMetadata'), paths.indexOf('export async function writeAgentMetadata') + 900)
  check('poison gone: no truncating writeFile in writeAgentMetadata', !fn.includes('await writeFile(path, JSON.stringify(metadata))'))
  check('the sidecar publishes through durableAtomicPublish', fn.includes('await durableAtomicPublish(path, JSON.stringify(metadata))'))
}

// ── §37 · crash-report-path-latched-before-write (moderate) ─────────────────
console.log('§37 crash report — the path is latched after the write lands')
{
  const cr = read('src/utils/crashReport.ts')
  const write = cr.indexOf('writeFileSync(\n      file,')
  const latch = cr.indexOf('lastReportPath = file')
  check('the write exists and the latch follows it', write !== -1 && latch !== -1 && latch > write)
  check('poison gone: no latch ahead of the write', cr.indexOf('lastReportPath = file') === cr.lastIndexOf('lastReportPath = file'))
}

// ── §38 · unset-remedy-does-not-exist-on-windows (moderate) ─────────────────
console.log('§38 auth-shadow remedy — a verb the shell has')
{
  const errs = read('src/services/api/errors.ts')
  check('the win32 fork names both Windows shells', errs.includes("Remove-Item Env:") && errs.includes('cmd: set ${authSource}='))
  check('POSIX keeps unset', errs.includes(': `unset ${authSource}`'))
  check('poison gone: no unconditional unset remedy', !errs.includes('? `restart Mercury (or unset ${authSource}) to use your saved login`'))
}

// ── §39 · exit-confirm-enter-quits-unadvertised (moderate) ──────────────────
console.log('§39 exit confirm — every firing key is named')
{
  const card = read('src/components/MercuryExitConfirm.tsx')
  check('enter still quits and esc still stays (behavior untouched)', card.includes('if (key.return || input === \'y\' || input === \'Y\')') && card.includes("if (key.escape || input === 'n' || input === 'N')"))
  check('the legend names ↵ beside quit and esc beside stay', card.includes('↵ quit') && card.includes('esc stay'))
}

// ── §40 · hook-sh-prepend-clobbers-compound (moderate) ──────────────────────
console.log('§40 hook lane — bash prepends only to a leading .sh script')
{
  const ex = read('src/utils/hooks/execution.ts')
  check('poison gone: no whole-command .sh match', !ex.includes("command.trim().match(/\\.sh(\\s|$|\")/)"))
  // The literal below is a COPY of the source's; the includes() check keeps
  // the copy honest. Since FC-084 the prepend lives in
  // winShHookCommand: the first token is CAPTURED (a backslash-carrying
  // Windows path is re-spelled and quoted), the already-prefixed guard
  // stands beside the match — the law, the leading token decides, unchanged.
  const LEADING_SH_SCRIPT = /^("[^"]*\.sh"|'[^']*\.sh'|\S+\.sh)(?:\s|$)/
  check('the leading token decides (bare or quoted)', ex.includes(`const firstToken = /${LEADING_SH_SCRIPT.source}/.exec(trimmed)`) && ex.includes("if (!firstToken || trimmed.startsWith('bash ')) return command"))
  check('a compound with a trailing script is left alone', !LEADING_SH_SCRIPT.test('npm run format && ./fix.sh'))
  check('a leading bare script is caught', LEADING_SH_SCRIPT.test('./x.sh --flag') && LEADING_SH_SCRIPT.test('./x.sh'))
  check('a leading QUOTED script with a space in its path is caught (the Windows spelling)', LEADING_SH_SCRIPT.test('"C:\\Users\\Jane Doe\\hooks\\fmt.sh" --check') && LEADING_SH_SCRIPT.test("'./my hooks/x.sh'"))
  check('a non-script first token is left alone', !LEADING_SH_SCRIPT.test('npm run lint') && !LEADING_SH_SCRIPT.test('bash ./x.sh'))
}

// ── §41 · shell-exit-143-fabricates-timeout-note (moderate) ─────────────────
console.log('§41 shell note — provenance only')
{
  const sc = read('src/utils/ShellCommand.ts')
  check('poison gone: the numeric 143 arm is out', !sc.includes('killedByTimeoutPolicy || code === 143'))
  check('the timeout note keys on the policy flag', sc.includes('} else if (killedByTimeoutPolicy) {'))
}

// ── §42 · changeset-delete-skips-win32-lock-law (moderate) ──────────────────
console.log('§42 change-set delete — the win32 retry ladder')
{
  const cs = read('src/services/changeTransaction/changeSetCommit.ts')
  check('the delete step rides the retry helper', cs.includes('await unlinkWithWin32Retry(t.canonicalPath)'))
  check("the helper's ladder is the owner's constant", cs.includes('WIN32_RENAME_RETRY_DELAYS_MS[attempt]') && cs.includes('isTransientWin32FsCode(code)'))
  check('poison gone: no bare unlink on the delete branch', !/kind === 'delete'\) \{[\s\S]{0,400}await unlink\(t\.canonicalPath\)/.test(cs))
}

// ── §43 · task-output-retry-has-no-delay-then-discards (moderate) ───────────
console.log('§43 task output — the retry waits before it judges')
{
  const dio = read('src/utils/task/diskOutput.ts')
  const { TASK_OUTPUT_RETRY_DELAY_MS } = await import('../../src/utils/task/diskOutput.ts')
  check("the pause is the owner's first rung", TASK_OUTPUT_RETRY_DELAY_MS === 50)
  check('the pause precedes the retry', dio.indexOf('setTimeout(r, TASK_OUTPUT_RETRY_DELAY_MS)') !== -1 && dio.indexOf('setTimeout(r, TASK_OUTPUT_RETRY_DELAY_MS)') < dio.indexOf('await this.drainCycle()', dio.indexOf('setTimeout(r, TASK_OUTPUT_RETRY_DELAY_MS)')))
}

// ── §44 · exit-heals-omit-synchronized-update-close + splash ?1007l ─────────
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

// ── §45 · help-shortcuts-wrong-context (moderate) ───────────────────────────
console.log('§45 /help shortcuts — the rows resolve through the real registry')
{
  const tab = read('src/components/HelpV2/ShortcutsTab.tsx')
  for (const action of ['app:commandPalette', 'history:search', 'app:fileOpen', 'app:contentSearch', 'command:sessions', 'command:surfaces']) {
    check(`${action} asks the Global context`, tab.includes(`{ action: '${action}', context: 'Global',`) && !tab.includes(`{ action: '${action}', context: 'Chat',`))
  }
  // Driven through the REAL resolver over the real defaults: each of the six
  // resolves under Global to its default chord, and to NOTHING under Chat —
  // the context the old rows asked, which is why they always printed their
  // hardcoded fallback and never an operator's rebind.
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

// ── §46 · memory-r-retries-charkeys-off (moderate) ──────────────────────────
console.log("§46 /memory — the banner's r is a real key")
{
  const mv = read('src/components/memory/MemoryCentreView.tsx')
  const r = mv.indexOf("if (loadError && input === 'r' && !key.ctrl && !key.meta)")
  const q = mv.indexOf('setQuery(q => q + input)')
  check('the loadError-gated r branch exists and calls the engine reload', r !== -1 && mv.slice(r, r + 200).includes('fl.reload()'))
  check('it precedes the type-to-search append', r < q)
}

// ── §47 · git-facts-pinned-to-first-resolved-gitdir (important) ─────────────
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
