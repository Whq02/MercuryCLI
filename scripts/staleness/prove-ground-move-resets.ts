#!/usr/bin/env bun
// ============================================================================
//  scripts/staleness/prove-ground-move-resets.ts — THE GROUND-MOVE RESET LAW
//  A ground move (applyHarnessGround — the concourse
//  rail's REPO pick and the Boot face's Projects pick) is a re-boot in the
//  picked repo. Every boot-memoized ground fact resets at that ONE seam, so
//  no screen keeps painting the boot folder's photo: write the truth, move
//  the ground, and the very next read shows the new truth.
//
//  THE THREE RULED BOUNDARIES (lead, at the scope ACK):
//   B1  a same-repo WORKTREE move never re-keys the project slice (the
//       canonical-root derivation shares one identity across worktrees;
//       sessionRestore's worktree re-home law is untouched);
//   B2  the TRUE boot ground is latched at the FIRST apply — the null-clear
//       returns exactly there, and nothing re-latches it mid-process;
//   B3  prove-projects-truth is control-run base vs post-fix at the land
//       (T3's newest-transcript red is pre-existing — KITRECORD §KR).
//
//  Sections: S0 the seam names every reset (source pins — the one-call-site
//  law) · S1 the latch law (B2, driven) · S2 the config key follows +
//  write-then-read lands on the NEW slice (driven) · S3 the worktree
//  boundary (B1, driven over a real `git worktree add`) · S4 the settings
//  project layer follows (driven) · S5 the instruction memo clears (driven)
//  · S6 getIsGit re-derives (driven) · S7 the example-command memo clears
//  (driven) · S8 extensions pending (driven) · S9 the settings watcher
//  re-arms on the new ground's paths (driven, timing-free: the armed
//  target list, never a watch event).
//
//  NEEDS-REAL-BOX (the face-process leg; the operator's driver line):
//    boot mercury in repo A (concourse on) → rail REPO pick → repo B →
//    /mcp and the settings view show B's slice; edit B/.mercury/settings.json
//    in another terminal → the view updates within a beat; Boot face →
//    Resume lists B's sessions. The cpu-pure sections below prove the same
//    seams in-process; only the paint is the box's.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Scratch config home BEFORE any src import (getMercuryHome memoizes the env).
const scratchHome = mkdtempSync(join(tmpdir(), 'stale-ground-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
// The config path must be the REAL one in this prover (NODE_ENV=test would
// short-circuit every config read onto in-memory test objects).
delete process.env.NODE_ENV

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} in ${cwd} → rc=${r.status}: ${r.stderr}`)
  }
}

// ── the scratch estate ──────────────────────────────────────────────────────
const estate = mkdtempSync(join(tmpdir(), 'stale-ground-'))
const bootDir = join(estate, 'boot')
const repoA = join(estate, 'repo-a')
const worktreeW = join(estate, 'wt-of-a')
const repoB = join(estate, 'repo-b')
for (const d of [bootDir, repoA, repoB]) mkdirSync(d, { recursive: true })
git(repoA, 'init', '-q')
git(repoA, '-c', 'user.email=stale@ground', '-c', 'user.name=staleground', 'commit', '-q', '--allow-empty', '-m', 'seed')
git(repoA, 'worktree', 'add', '-q', worktreeW)
git(repoB, 'init', '-q')
mkdirSync(join(repoB, '.mercury'), { recursive: true })
writeFileSync(join(repoB, '.mercury', 'settings.json'), JSON.stringify({ env: { STALE_GROUND_PIN: 'B' } }, null, 2))
const bootReal = realpathSync(bootDir).normalize('NFC')
const repoAReal = realpathSync(repoA).normalize('NFC')
const worktreeWReal = realpathSync(worktreeW).normalize('NFC')
const repoBReal = realpathSync(repoB).normalize('NFC')

// The repo root, captured BEFORE the chdir below — every source read is
// absolute from here on (the prover's cwd is the drive's, not the repo's).
const repoRoot = process.cwd()

// The prover's own boot ground: chdir BEFORE the first src import — the
// session-identity owner resolves its cwd trio eagerly at module load.
process.chdir(bootDir)

// ── S0: the seam names every reset (the one-call-site law) ──────────────────
{
  const ground = readFileSync(join(repoRoot, 'src/services/switchboard/harnessGround.ts'), 'utf8')
  check('S0 the T2 contract survives (chdir + setCwdState + slot pulse)', ground.includes('process.chdir(target)') && ground.includes('setCwdState(target)') && ground.includes('emitFocusedSessionConnectorChanged()'))
  check('S0 the re-boot trio (originalCwd + projectRoot move at the seam)', ground.includes('setOriginalCwd(target)') && ground.includes('setProjectRoot(target)'))
  check('S0 the true-boot latch (first apply, null-clear target)', ground.includes('trueBootGround'))
  check('S0 git-facts reground stays', ground.includes('regroundGitWatch()'))
  check('S0 the config-key memo resets', ground.includes('getProjectPathForConfig.cache?.clear?.()'))
  check('S0 the settings caches reset + the watcher re-arms', ground.includes('resetSettingsCache()') && ground.includes('settingsChangeDetector.reground()'))
  check('S0 the instruction walk clears (the setup.ts precedent)', ground.includes('clearInstructionFileCaches()'))
  check('S0 the context memos clear (gitStatus · system · user · isGit)', ground.includes('getGitStatus.cache?.clear?.()') && ground.includes('getSystemContext.cache?.clear?.()') && ground.includes('getUserContext.cache?.clear?.()') && ground.includes('getIsGit.cache?.clear?.()'))
  check('S0 the command/skill rosters clear (the exported full clear)', ground.includes('clearCommandsCache()'))
  check('S0 the agents definitions cache clears', ground.includes('clearAgentDefinitionsCache()'))
  check('S0 the example-command memos clear', ground.includes('getExampleCommandFromCache.cache?.clear?.()') && ground.includes('refreshExampleCommands.cache?.clear?.()'))
  check('S0 the onboarding memo clears', ground.includes('shouldShowProjectOnboarding.cache?.clear?.()'))
  check('S0 the plans-directory memo clears', ground.includes('getPlansDirectory.cache.clear()'))
  check('S0 extensions go PENDING, never hot-swapped', ground.includes('setExtensionsPending(true)'))
}

// ── the estate under drive ──────────────────────────────────────────────────
const state = await import('../../src/bootstrap/state.js')
const detector = await import('../../src/utils/settings/changeDetector.js')
const ground = await import('../../src/services/switchboard/harnessGround.js')
const projectConfig = await import('../../src/utils/config/projectConfig.js')
const settings = await import('../../src/utils/settings/settings.js')
const gitUtils = await import('../../src/utils/git.js')
const env = await import('../../src/utils/env.js')
const instructions = await import('../../src/services/instructions/engine.js')
const examples = await import('../../src/utils/exampleCommands.js')
const extensionsBoot = await import('../../src/extensions/boot.js')
const globalConfig = await import('../../src/utils/config/globalConfig.js')
// The config-read gate (the boot path arms it; a prover must too).
globalConfig.enableConfigs()

// The detector arms over the BOOT ground first, so every apply exercises
// the re-arm (timing-free assertions over the armed target list only).
await detector.initialize()

// ── S1: the latch law (B2) ──────────────────────────────────────────────────
{
  const bootObserved = state.getOriginalCwd()
  check('S1 the prover boots where it thinks it does', bootObserved === bootReal, `observed ${bootObserved}`)
  await ground.applyHarnessGround(repoAReal)
  check('S1 the ground move re-homes originalCwd (the re-boot reading)', state.getOriginalCwd() === repoAReal)
  check('S1 …and projectRoot', state.getProjectRoot() === repoAReal)
  check('S1 …and the cwd owner', state.getCwdState() === repoAReal)
  const cleared = await ground.applyHarnessGround(null)
  check('S1 the null-clear returns to the TRUE boot ground', cleared === bootReal && state.getOriginalCwd() === bootReal)
  await ground.applyHarnessGround(repoBReal)
  const clearedAgain = await ground.applyHarnessGround(null)
  check('S1 the latch never re-latches (a second clear still lands on boot)', clearedAgain === bootReal && state.getOriginalCwd() === bootReal)
}

// ── S2: the config key follows + write-then-read lands on the NEW slice ─────
{
  const keyBoot = projectConfig.getProjectPathForConfig()
  const keyBootExpected = projectConfig.projectConfigKeyForWorkspace(bootReal)
  check('S2 pre-move: the key is the boot ground’s', keyBoot === keyBootExpected, `key ${keyBoot}`)
  await ground.applyHarnessGround(repoAReal)
  const keyA = projectConfig.getProjectPathForConfig()
  const keyAExpected = projectConfig.projectConfigKeyForWorkspace(repoAReal)
  check('S2 post-move: the key is the PICKED repo’s (the memo re-derived)', keyA === keyAExpected && keyA !== keyBoot, `key ${keyA}`)
  projectConfig.saveCurrentProjectConfig(current => ({ ...current, exampleFiles: ['stale-ground-pin'] }))
  const rawText = readFileSync(env.getGlobalMercuryFile(), 'utf8')
  const raw = JSON.parse(rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText) as { projects?: Record<string, { exampleFiles?: string[] }> }
  const landed = raw.projects?.[keyA]?.exampleFiles?.[0] === 'stale-ground-pin'
  const leakedToBoot = raw.projects?.[keyBoot]?.exampleFiles?.[0] === 'stale-ground-pin'
  check('S2 write-then-read: the save lands on the NEW slice, never the boot’s', landed && !leakedToBoot, `projects keys: ${Object.keys(raw.projects ?? {}).join(' · ')}`)
}

// ── S3: the worktree boundary (B1) ──────────────────────────────────────────
{
  const keyA = projectConfig.projectConfigKeyForWorkspace(repoAReal)
  const keyW = projectConfig.projectConfigKeyForWorkspace(worktreeWReal)
  check('S3 the canonical derivation shares ONE identity across worktrees', keyW === keyA, `A ${keyA} · W ${keyW}`)
  await ground.applyHarnessGround(worktreeWReal)
  check('S3 a same-repo worktree move never re-keys the project slice', projectConfig.getProjectPathForConfig() === keyA)
  const restore = readFileSync(join(repoRoot, 'src/utils/sessionRestore.ts'), 'utf8')
  check('S3 sessionRestore’s worktree re-home law is untouched', restore.includes('setOriginalCwd(worktreeSession.worktreePath)'))
}

// ── S4: the settings project layer follows the ground ───────────────────────
{
  await ground.applyHarnessGround(bootReal)
  const pre = settings.getSettingsForSource('projectSettings')
  check('S4 pre-move: the boot ground has no project settings', pre === null || (pre as { env?: Record<string, string> }).env?.STALE_GROUND_PIN === undefined)
  await ground.applyHarnessGround(repoBReal)
  const post = settings.getSettingsForSource('projectSettings') as { env?: Record<string, string> } | null
  check('S4 post-move: the PICKED repo’s settings answer (write, move, read)', post?.env?.STALE_GROUND_PIN === 'B', JSON.stringify(post))
}

// ── S5: the instruction memo clears ─────────────────────────────────────────
{
  await instructions.getInstructionFiles()
  const primed = instructions.getInstructionFiles.cache?.has?.(undefined) === true
  await ground.applyHarnessGround(repoAReal)
  const clearedAfter = instructions.getInstructionFiles.cache?.has?.(undefined) === false
  check('S5 the instruction walk re-runs after a move (primed memo cleared)', primed && clearedAfter)
}

// ── S6: getIsGit re-derives on the new ground ───────────────────────────────
{
  await ground.applyHarnessGround(bootReal)
  const atBoot = await gitUtils.getIsGit()
  await ground.applyHarnessGround(repoAReal)
  const atRepo = await gitUtils.getIsGit()
  check('S6 is-git re-derives (plain boot folder → git repo)', atBoot === false && atRepo === true)
}

// ── S7: the example-command memo clears ─────────────────────────────────────
{
  void examples.getExampleCommandFromCache()
  const primed = examples.getExampleCommandFromCache.cache?.has?.(undefined) === true
  await ground.applyHarnessGround(repoBReal)
  const clearedAfter = examples.getExampleCommandFromCache.cache?.has?.(undefined) === false
  check('S7 the example-command memo clears at the seam', primed && clearedAfter)
}

// ── S8: extensions go PENDING ───────────────────────────────────────────────
{
  extensionsBoot.setExtensionsPending(false)
  await ground.applyHarnessGround(repoAReal)
  check('S8 a ground move marks the extension roster PENDING (the photo flag)', extensionsBoot.isExtensionsPending() === true)
}

// ── S9: the settings watcher re-arms on the new ground ──────────────────────
{
  await ground.applyHarnessGround(repoBReal)
  const targets = detector._watchTargetsForTesting()
  const wantsB = targets.some(t => t.startsWith(repoBReal) && t.endsWith('settings.json'))
  const droppedBoot = !targets.some(t => t.startsWith(bootReal + '/') && t.endsWith(join('.mercury', 'settings.json')))
  check('S9 the watcher’s armed targets follow the ground', wantsB, targets.join(' · '))
  check('S9 the OLD ground’s project settings are no longer armed', droppedBoot)
}

// ── S10: the --worktree BOOT rides the seam (FC-072) ────────────────────────
// setup.ts's worktree block hand-rolled the trio — bookkeeping moved, the OS
// cwd and the git-facts cache did not, so the realm row painted the BASE
// repo's branch and dirty flag while naming the worktree's folder. The boot
// now calls the ONE ground-move owner.
{
  const setupSrc = readFileSync(join(repoRoot, 'src/setup.ts'), 'utf8')
  check('S10 the worktree boot calls applyHarnessGround (the one seam)', setupSrc.includes('applyHarnessGround('))
  const worktreeBlock = setupSrc.slice(setupSrc.indexOf('worktreeSession.worktreePath'))
  check(
    'S10 the hand-rolled trio is GONE from the worktree block (no second owner)',
    !worktreeBlock.slice(0, 1200).includes('setOriginalCwd(') && !worktreeBlock.slice(0, 1200).includes('setProjectRoot('),
  )
  // The beat the partial trio lacked, driven: the owner lands the OS cwd on
  // the worktree, so clean/unpushed git spawns answer from the RIGHT repo.
  await ground.applyHarnessGround(worktreeWReal)
  check('S10 the OS cwd lands on the worktree (chdir is part of the move)', realpathSync(process.cwd()).normalize('NFC') === worktreeWReal)
  await ground.applyHarnessGround(repoBReal)
}

await detector.dispose()
console.log(failures === 0 ? 'prove-ground-move-resets: GREEN' : `prove-ground-move-resets: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
