#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const scratchHome = mkdtempSync(join(tmpdir(), 'stale-ground-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
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

const repoRoot = process.cwd()

process.chdir(bootDir)

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
globalConfig.enableConfigs()

await detector.initialize()

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

{
  const keyA = projectConfig.projectConfigKeyForWorkspace(repoAReal)
  const keyW = projectConfig.projectConfigKeyForWorkspace(worktreeWReal)
  check('S3 the canonical derivation shares ONE identity across worktrees', keyW === keyA, `A ${keyA} · W ${keyW}`)
  await ground.applyHarnessGround(worktreeWReal)
  check('S3 a same-repo worktree move never re-keys the project slice', projectConfig.getProjectPathForConfig() === keyA)
  const restore = readFileSync(join(repoRoot, 'src/utils/sessionRestore.ts'), 'utf8')
  check('S3 sessionRestore’s worktree re-home law is untouched', restore.includes('setOriginalCwd(worktreeSession.worktreePath)'))
}

{
  await ground.applyHarnessGround(bootReal)
  const pre = settings.getSettingsForSource('projectSettings')
  check('S4 pre-move: the boot ground has no project settings', pre === null || (pre as { env?: Record<string, string> }).env?.STALE_GROUND_PIN === undefined)
  await ground.applyHarnessGround(repoBReal)
  const post = settings.getSettingsForSource('projectSettings') as { env?: Record<string, string> } | null
  check('S4 post-move: the PICKED repo’s settings answer (write, move, read)', post?.env?.STALE_GROUND_PIN === 'B', JSON.stringify(post))
}

{
  await instructions.getInstructionFiles()
  const primed = instructions.getInstructionFiles.cache?.has?.(undefined) === true
  await ground.applyHarnessGround(repoAReal)
  const clearedAfter = instructions.getInstructionFiles.cache?.has?.(undefined) === false
  check('S5 the instruction walk re-runs after a move (primed memo cleared)', primed && clearedAfter)
}

{
  await ground.applyHarnessGround(bootReal)
  const atBoot = await gitUtils.getIsGit()
  await ground.applyHarnessGround(repoAReal)
  const atRepo = await gitUtils.getIsGit()
  check('S6 is-git re-derives (plain boot folder → git repo)', atBoot === false && atRepo === true)
}

{
  void examples.getExampleCommandFromCache()
  const primed = examples.getExampleCommandFromCache.cache?.has?.(undefined) === true
  await ground.applyHarnessGround(repoBReal)
  const clearedAfter = examples.getExampleCommandFromCache.cache?.has?.(undefined) === false
  check('S7 the example-command memo clears at the seam', primed && clearedAfter)
}

{
  extensionsBoot.setExtensionsPending(false)
  await ground.applyHarnessGround(repoAReal)
  check('S8 a ground move marks the extension roster PENDING (the photo flag)', extensionsBoot.isExtensionsPending() === true)
}

{
  await ground.applyHarnessGround(repoBReal)
  const targets = detector._watchTargetsForTesting()
  const wantsB = targets.some(t => t.startsWith(repoBReal) && t.endsWith('settings.json'))
  const droppedBoot = !targets.some(t => t.startsWith(bootReal + '/') && t.endsWith(join('.mercury', 'settings.json')))
  check('S9 the watcher’s armed targets follow the ground', wantsB, targets.join(' · '))
  check('S9 the OLD ground’s project settings are no longer armed', droppedBoot)
}

{
  const setupSrc = readFileSync(join(repoRoot, 'src/setup.ts'), 'utf8')
  check('S10 the worktree boot calls applyHarnessGround (the one seam)', setupSrc.includes('applyHarnessGround('))
  const worktreeBlock = setupSrc.slice(setupSrc.indexOf('worktreeSession.worktreePath'))
  check(
    'S10 the hand-rolled trio is GONE from the worktree block (no second owner)',
    !worktreeBlock.slice(0, 1200).includes('setOriginalCwd(') && !worktreeBlock.slice(0, 1200).includes('setProjectRoot('),
  )
  await ground.applyHarnessGround(worktreeWReal)
  check('S10 the OS cwd lands on the worktree (chdir is part of the move)', realpathSync(process.cwd()).normalize('NFC') === worktreeWReal)
  await ground.applyHarnessGround(repoBReal)
}

await detector.dispose()
console.log(failures === 0 ? 'prove-ground-move-resets: GREEN' : `prove-ground-move-resets: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
