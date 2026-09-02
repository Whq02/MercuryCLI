#!/usr/bin/env bun
// ============================================================================
//  scripts/splash/prove-splash-receipt.ts — receipt-protocol
//  conformance.
//
//  The launchers no longer parse anything the splash writes; the RUNTIME is
//  the one receipt consumer (src/substrate/splashHandover.ts under
//  MERCURY_SPLASH_HANDOFF=1). This prover pins the whole acceptance grid
//  OFF-PLATFORM — the validation matrix runs identically everywhere, so the
//  Windows lane only has to prove the SHELL half (scripts/windows/):
//    (1) decideSplashReceipt — the validation matrix, including the exact
//        1.5.4 murder bytes ("\n\nheld\n") and every malformed shape: none
//        may ever cost a boot;
//    (2) consumeSplashHandover — file behavior: one-shot env consume,
//        no-touch when unarmed, delete-after-read, chdir + argv splice;
//    (3) the boot-completion beacon — the asset's stamp shape round-trips
//        through bootBeacon's validated reader; clear removes it;
//    (4) writer-side pins on the asset — JSON receipt only, exit-code
//        contract present, no plain-twin write.
// ============================================================================
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootJourneyIsExplicit, consumeBootSurfaceIntent, consumeFaceDoorDeepLink, consumeKitManagerDeepLink, decideSplashReceipt, consumeSplashHandover, markExplicitBootJourney } from '../../src/substrate/splashHandover.js'
import { bootAttemptsPath, clearBootAttempts, formatBootResidueWarning, readBootAttemptResidue } from '../../src/substrate/bootBeacon.js'

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const NOW = 1_700_000_000_000
const fresh = (o: Record<string, unknown>): string => JSON.stringify({ version: 1, ts: NOW, ...o })
const dirs = new Set(['/proof/project'])
const dirExists = (d: string): boolean => dirs.has(d)

//
section('(1) decideSplashReceipt — the validation matrix (no shape may cost a boot)')
{
  const d = (raw: string | null) => decideSplashReceipt(raw, NOW, dirExists)
  check('absent file ⇒ no-file, nothing applied', d(null).reason === 'no-file' && d(null).apply === null)
  check('the 1.5.4 murder bytes ("\\n\\nheld\\n") ⇒ malformed, nothing applied', d('\n\nheld\n').reason === 'malformed')
  check('non-JSON garbage ⇒ malformed', d('set /p is not a parser').reason === 'malformed')
  check('multi-line JSON-ish garbage ⇒ malformed', d('{"version":\n\n').reason === 'malformed')
  check('wrong version ⇒ malformed', d(fresh({}).replace('"version":1', '"version":2')).reason === 'malformed')
  check('missing ts ⇒ malformed', d(JSON.stringify({ version: 1, action: 'continue' })).reason === 'malformed')
  check('stale (>120s old) ⇒ stale', d(JSON.stringify({ version: 1, ts: NOW - 121_000, action: 'continue' })).reason === 'stale')
  check('future-dated (>120s ahead) ⇒ stale', d(JSON.stringify({ version: 1, ts: NOW + 121_000, action: 'continue' })).reason === 'stale')
  check('a stale receipt arms NO boot-surface intent', consumeBootSurfaceIntent() === null)
  check('screen-only receipt (plain new-session) ⇒ nothing to apply', d(fresh({ screen: 'held' })).reason === 'screen-only')
  // The plain screen-fact receipt arms NO intent: the Boot face is every
  // interactive boot's landing (the resolver's one landing rule),
  // whichever door the boot came
  // through; the resolver alone applies the gates (fullscreen · explicit
  // argv journey · concourse policy).
  check('screen-only ⇒ no boot-surface intent (the landing is the resolver\'s rule, not the receipt\'s)', consumeBootSurfaceIntent() === null)
  check(
    "screen-only 'restored' arms nothing either (the resolver's live fullscreen gate owns the inline refusal)",
    d(fresh({ screen: 'restored' })).reason === 'screen-only' && consumeBootSurfaceIntent() === null,
  )
  check('unknown action ⇒ refused, nothing applied', d(fresh({ action: 'rm -rf' })).reason === 'unknown-action')
  check('non-string action ⇒ refused', d(fresh({ action: 42 })).reason === 'unknown-action')
  check('cancel is IGNORED (a leftover cancel must never kill a later boot)', d(fresh({ action: 'cancel' })).reason === 'cancel-ignored' && d(fresh({ action: 'cancel' })).apply === null)
  const cont = d(fresh({ action: 'continue', dir: '/proof/project' }))
  check('continue + existing dir ⇒ chdir + --continue', cont.apply?.chdir === '/proof/project' && cont.apply?.spliceArg === '--continue')
  const contNoDir = d(fresh({ action: 'continue' }))
  check('continue without dir ⇒ --continue alone', contNoDir.apply?.spliceArg === '--continue' && contNoDir.apply?.chdir === undefined)
  const contBadDir = d(fresh({ action: 'continue', dir: '/vanished' }))
  check('continue + vanished dir ⇒ --continue alone (dir dropped)', contBadDir.apply?.spliceArg === '--continue' && contBadDir.apply?.chdir === undefined)
  // Way A (operator-ruled): the resume and
  // doctor picks arm the FACE-DOOR deep-link instead of a splice — the
  // boot lands the face with its own sub-view open; the wire vocabulary is
  // unchanged (an older runtime reading the same receipt splices as it
  // always did — the protocol's degradation law).
  const res = d(fresh({ action: 'resume', dir: '/proof/project' }))
  check("resume + dir ⇒ chdir alone, NO splice, the 'resume' face door armed once", res.apply?.chdir === '/proof/project' && res.apply?.spliceArg === undefined && consumeFaceDoorDeepLink() === 'resume' && consumeFaceDoorDeepLink() === null)
  const doc = d(fresh({ action: 'doctor' }))
  check("doctor ⇒ nothing to chdir or splice, the 'health' face door armed once", doc.apply === null && consumeFaceDoorDeepLink() === 'health' && consumeFaceDoorDeepLink() === null)
  const conc = d(fresh({ action: 'concourse' }))
  // RFI-3: 'concourse' no longer splices
  // '/concourse' into argv (the post-paint splice flashed the un-navigated
  // Main REPL) — it arms the typed one-shot boot-surface intent the
  // initial-surface resolver consumes BEFORE the first visible commit.
  check(
    'concourse ⇒ the typed boot-surface intent, never an argv splice or chdir (RFI-3)',
    conc.apply === null && conc.reason === 'applied' && consumeBootSurfaceIntent() === 'concourse',
  )
  check('the boot-surface intent is one-shot (a second read is empty)', consumeBootSurfaceIntent() === null)
  // NEW-2: the intent union is closed over BOTH destinations —
  // an explicit continue/resume/doctor choice records 'repl' so the chosen
  // conversation owns the first frame even under a policy-always Concourse.
  void d(fresh({ action: 'continue' }))
  check("continue ⇒ 'repl' boot-surface intent (the chosen journey outranks policy)", consumeBootSurfaceIntent() === 'repl')
  // Resume/doctor arm NO boot-surface intent — the face-door
  // deep-link is their whole road (its resolver peek carries the same
  // outrank; prove-face-doors §12 drives both directions).
  void d(fresh({ action: 'resume' }))
  check("resume ⇒ NO boot-surface intent (the face door rides instead)", consumeBootSurfaceIntent() === null && consumeFaceDoorDeepLink() === 'resume')
  void d(fresh({ action: 'doctor' }))
  check("doctor ⇒ NO boot-surface intent (the face door rides instead)", consumeBootSurfaceIntent() === null && consumeFaceDoorDeepLink() === 'health')
  // The launcher's MCPs & Skills row hands over with
  // `kit` — the Boot face is the landing (no boot-surface intent, no chdir,
  // no argv splice); it arms the manager deep-link the face consumes ONCE.
  const kit = d(fresh({ action: 'kit' }))
  check('kit ⇒ applied with nothing to chdir or splice (the face is the landing)', kit.apply === null && kit.reason === 'applied')
  check('kit arms NO boot-surface intent (the resolver\'s one landing rule stands)', consumeBootSurfaceIntent() === null)
  check('kit arms the manager deep-link (consumed once — the second read is empty)', consumeKitManagerDeepLink() === true && consumeKitManagerDeepLink() === false)
  check('an unknown action never arms the manager (the deep-link rides the closed vocabulary)', d(fresh({ action: 'kit-manager' })).reason === 'unknown-action' && consumeKitManagerDeepLink() === false)
  check('a stale kit receipt arms nothing', d(JSON.stringify({ version: 1, ts: NOW - 121_000, action: 'kit' })).reason === 'stale' && consumeKitManagerDeepLink() === false)
  // The Saturn Scheduler row rides the
  // face-door grammar whole — the kit/doctor pattern: the face is the
  // landing, the scheduler layer opens from the one-shot; an older runtime
  // reads 'unknown-action' and boots plain (the protocol's law).
  const sat = d(fresh({ action: 'saturn' }))
  check('saturn ⇒ applied with nothing to chdir or splice (the face is the landing)', sat.apply === null && sat.reason === 'applied')
  check('saturn arms NO boot-surface intent (the one landing rule stands)', consumeBootSurfaceIntent() === null)
  check("saturn arms the 'saturn' face door once (the second read is empty)", consumeFaceDoorDeepLink() === 'saturn' && consumeFaceDoorDeepLink() === null)
  check('a stale saturn receipt arms nothing', d(JSON.stringify({ version: 1, ts: NOW - 121_000, action: 'saturn' })).reason === 'stale' && consumeFaceDoorDeepLink() === null)

  // The `logins` action rides the face-door grammar whole
  // (the saturn rows' exact shape — the ruling's wire word).
  const logins = d(fresh({ action: 'logins' }))
  check('logins ⇒ applied with nothing to chdir or splice (the face is the landing)', logins.apply === null && logins.reason === 'applied')
  check('logins arms NO boot-surface intent (the one landing rule stands)', consumeBootSurfaceIntent() === null)
  check("logins arms the 'logins' face door once (the second read is empty)", consumeFaceDoorDeepLink() === 'logins' && consumeFaceDoorDeepLink() === null)
  check('a stale logins receipt arms nothing', d(JSON.stringify({ version: 1, ts: NOW - 121_000, action: 'logins' })).reason === 'stale' && consumeFaceDoorDeepLink() === null)

  // The `agents` action rides the face-door grammar whole
  // (the saturn/logins rows' exact shape — the operator's boot-menu door).
  const agents = d(fresh({ action: 'agents' }))
  check('agents ⇒ applied with nothing to chdir or splice (the face is the landing)', agents.apply === null && agents.reason === 'applied')
  check('agents arms NO boot-surface intent (the one landing rule stands)', consumeBootSurfaceIntent() === null)
  check("agents arms the 'agents' face door once (the second read is empty)", consumeFaceDoorDeepLink() === 'agents' && consumeFaceDoorDeepLink() === null)
  check('a stale agents receipt arms nothing', d(JSON.stringify({ version: 1, ts: NOW - 121_000, action: 'agents' })).reason === 'stale' && consumeFaceDoorDeepLink() === null)
  const proj = d(fresh({ action: 'project', dir: '/proof/project' }))
  check("project arms NO intent (a chdir alone — the destination is the policy's)", consumeBootSurfaceIntent() === null)
  check('project ⇒ chdir alone', proj.apply?.chdir === '/proof/project' && proj.apply?.spliceArg === undefined)
  check('project + vanished dir ⇒ nothing left to apply', d(fresh({ action: 'project', dir: '/vanished' })).apply === null)
  check('non-string dir is ignored, action still applies', d(fresh({ action: 'continue', dir: 7 })).apply?.spliceArg === '--continue')

  // launch-id gating — simultaneous launches sharing one home
  const dId = (raw: string, own: string | null) => decideSplashReceipt(raw, NOW, dirExists, own)
  check('matching launch id ⇒ applied', dId(fresh({ action: 'continue', launchId: 'L1' }), 'L1').apply?.spliceArg === '--continue')
  check('FOREIGN launch id ⇒ never applied (a sibling launch owns it)', dId(fresh({ action: 'continue', launchId: 'L1' }), 'L2').reason === 'foreign-launch')
  check('id-less receipt + own id ⇒ applied (older-splash compat rung)', dId(fresh({ action: 'continue' }), 'L2').apply?.spliceArg === '--continue')
  check('id-carrying receipt + id-less boot ⇒ applied (direct-boot compat rung)', dId(fresh({ action: 'continue', launchId: 'L1' }), null).apply?.spliceArg === '--continue')
}

//
section('(1b) the explicit-journey one-shot (argv journeys outrank the landing)')
{
  check('unmarked boot: no explicit journey', bootJourneyIsExplicit() === false)
  markExplicitBootJourney()
  check('marked boot: the resolver reads the fact live', bootJourneyIsExplicit() === true)
}

//
section('(2) consumeSplashHandover — one-shot env, file discipline, application')
{
  const scratch = mkdtempSync(join(tmpdir(), 'splash receipt '))
  const home = join(scratch, 'home')
  // Spaces + non-ASCII in the picked dir: the dir handover NEVER worked on
  // cmd (a pre-existing bug — batch parsing died on the
  // receipt first); the runtime consumer is encoding-safe by construction,
  // and this fixture pins it.
  const project = join(scratch, 'picked café-日本 project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  const receipt = join(home, 'splash-action.json')
  const savedArgv = process.argv.slice()
  const savedCwd = process.cwd()
  const savedEnv = {
    MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR,
    MERCURY_SPLASH_HANDOFF: process.env.MERCURY_SPLASH_HANDOFF,
    MERCURY_SPLASH_HANDOFF: process.env.MERCURY_SPLASH_HANDOFF,
  }
  // Pin BOTH explicit home rungs (ambient-state law: a live session exports
  // its own config-dir pair, which would otherwise win the resolution).
  process.env.MERCURY_CONFIG_DIR = home
  try {
    // unarmed: the receipt is NEVER touched (a concurrent verb boot must not
    // eat an interactive boot's receipt)
    delete process.env.MERCURY_SPLASH_HANDOFF
    delete process.env.MERCURY_SPLASH_HANDOFF
    writeFileSync(receipt, fresh({ action: 'continue', dir: project }).replace(String(NOW), String(Date.now())))
    consumeSplashHandover()
    check('unarmed: the receipt survives untouched', existsSync(receipt))
    check('unarmed: argv untouched', process.argv.length === savedArgv.length)

    // armed: applied one-shot — env consumed, file deleted, chdir + splice
    process.env.MERCURY_SPLASH_HANDOFF = '1'
    consumeSplashHandover()
    check('armed: the env marker is consumed one-shot', process.env.MERCURY_SPLASH_HANDOFF === undefined)
    check('armed: the receipt is deleted after the read', !existsSync(receipt))
    check('armed: --continue spliced at argv[2]', process.argv[2] === '--continue', JSON.stringify(process.argv.slice(2, 4)))
    check('armed: chdir into the picked project', process.cwd() === require('node:fs').realpathSync(project) || process.cwd() === project, process.cwd())
    process.argv.length = 0
    process.argv.push(...savedArgv)
    process.chdir(savedCwd)

    // armed + murder bytes: plain boot, file still consumed
    writeFileSync(receipt, '\n\nheld\n')
    writeFileSync(join(home, 'splash-action.txt'), '\n\nheld\n')
    process.env.MERCURY_SPLASH_HANDOFF = '1'
    consumeSplashHandover()
    check('armed + garbage: argv untouched (plain boot, never a refusal)', process.argv.length === savedArgv.length)
    check('armed + garbage: both receipt spellings swept', !existsSync(receipt) && !existsSync(join(home, 'splash-action.txt')))

    // armed + absent file: clean no-op
    process.env.MERCURY_SPLASH_HANDOFF = '1'
    consumeSplashHandover()
    check('armed + absent: clean no-op', process.argv.length === savedArgv.length && process.cwd() === savedCwd)

    // armed + fresh cancel receipt: IGNORED — the process must keep booting
    writeFileSync(receipt, JSON.stringify({ version: 1, ts: Date.now(), action: 'cancel' }))
    process.env.MERCURY_SPLASH_HANDOFF = '1'
    consumeSplashHandover()
    check('armed + cancel: ignored (no exit, no argv change), file consumed', process.argv.length === savedArgv.length && !existsSync(receipt))

    // armed + FOREIGN receipt — left on disk for its own runtime
    writeFileSync(receipt, JSON.stringify({ version: 1, ts: Date.now(), action: 'continue', dir: project, launchId: 'sibling-launch' }))
    process.env.MERCURY_SPLASH_HANDOFF = '1'
    process.env.MERCURY_LAUNCH_ID = 'this-launch'
    consumeSplashHandover()
    check('armed + foreign id: nothing applied, the receipt SURVIVES for its own runtime', process.argv.length === savedArgv.length && existsSync(receipt))
    delete process.env.MERCURY_LAUNCH_ID
    rmSync(receipt, { force: true })
  } finally {
    process.argv.length = 0
    process.argv.push(...savedArgv)
    process.chdir(savedCwd)
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(scratch, { recursive: true, force: true })
  }
}

//
section('(3) the boot-completion beacon — asset stamp shape ⇄ bootBeacon reader')
{
  const scratch = mkdtempSync(join(tmpdir(), 'boot beacon '))
  try {
    const p = bootAttemptsPath(scratch)
    check('the beacon path is home-scoped boot-attempts.json', p === join(scratch, 'boot-attempts.json'))
    // the EXACT writer shape from assets/splash/mercury-splash.mjs
    writeFileSync(p, JSON.stringify({ version: 1, attempts: [NOW - 60_000, NOW] }) + '\n')
    const residue = readBootAttemptResidue(scratch)
    check('the asset shape round-trips (count + lastTs)', residue?.count === 2 && residue?.lastTs === NOW, JSON.stringify(residue))
    check('the warning names the rollback recovery', formatBootResidueWarning(residue!).includes('mercury update --rollback'))
    clearBootAttempts(scratch)
    check('clear removes the file (a completed startup answers the residue)', !existsSync(p))
    writeFileSync(p, 'not json at all')
    check('malformed beacon file ⇒ null (never a crash)', readBootAttemptResidue(scratch) === null)
    writeFileSync(p, JSON.stringify({ version: 9, attempts: [1] }))
    check('wrong version ⇒ null', readBootAttemptResidue(scratch) === null)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

//
section('(4) writer-side pins — the asset speaks ONLY the new protocol')
{
  const src = readFileSync(join(import.meta.dir, '..', '..', 'assets', 'splash', 'mercury-splash.mjs'), 'utf8')
  check('the receipt writer emits JSON only (no plain-twin write anywhere)', !src.includes("writeFileSync(join(CONFIG_HOME, 'splash-action.txt')"))
  check('the exit funnel derives the launcher contract (130 cancel · 20 restored)', src.includes('if (cancelled) exitCode = 130') && src.includes("exitCode = 20"))
  check('the beacon stamp uses the bootBeacon shape (version 1 + attempts)', src.includes("JSON.stringify({ version: 1, attempts })"))
  check('the startup sweep is AGE-GATED (LH-01: a live sibling launch is never clobbered)', src.includes("['splash-action.json', 'splash-action.txt']") && src.includes('10 * 60 * 1000'))
  check('the receipt embeds the LH-01 launch id when the launcher minted one', src.includes('MERCURY_LAUNCH_ID') && src.includes('launchId: LAUNCH_ID'))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SPLASH RECEIPT PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
