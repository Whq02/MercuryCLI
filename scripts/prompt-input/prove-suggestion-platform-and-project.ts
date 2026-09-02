#!/usr/bin/env bun
//  global index serves project A's paths under project B's cwd.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'suggestion-law-'))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' @-path suggestions — separators, project keying, timers')
console.log('============================================================')

console.log('\n── §1 separators ──')
{
  const { canonicalizeSuggestionPath, displaySuggestionPath } = await import(
    join(REPO, 'src/hooks/fileSuggestions.ts')
  )
  check("win32: a backslash query folds to the canonical spelling", canonicalizeSuggestionPath('src\\ut', '\\') === 'src/ut')
  check('win32: a forward-slash query is already canonical', canonicalizeSuggestionPath('src/ut', '\\') === 'src/ut')
  check('POSIX: a backslash is a legal byte, untouched', canonicalizeSuggestionPath('a\\b', '/') === 'a\\b')
  check('win32: results render in the platform separator', displaySuggestionPath('src/utils/x.ts', '\\') === 'src\\utils\\x.ts')
  check('POSIX: results render untouched', displaySuggestionPath('src/utils/x.ts', '/') === 'src/utils/x.ts')
  check('win32 round trip: canonical → display → canonical', canonicalizeSuggestionPath(displaySuggestionPath('a/b/c', '\\'), '\\') === 'a/b/c')

  const { isPathLikeToken } = await import(join(REPO, 'src/utils/suggestions/directoryCompletion.ts'))
  check('the Windows relative spellings are path-like: .\\build', isPathLikeToken('.\\build'))
  check('..\\lib is path-like', isPathLikeToken('..\\lib'))
  check('~\\x is path-like', isPathLikeToken('~\\x'))
  check('the POSIX spellings keep working: ./build', isPathLikeToken('./build'))
  check('a drive prefix in either slash is path-like', isPathLikeToken('C:\\x') && isPathLikeToken('C:/x'))
  check('a bare word is not a path', !isPathLikeToken('word'))
}

console.log('\n── §2 per-project keying (two projects, one process) ──')
{
  const projA = join(SCRATCH, 'proj-alpha')
  const projB = join(SCRATCH, 'proj-beta')
  mkdirSync(projA, { recursive: true })
  mkdirSync(projB, { recursive: true })
  writeFileSync(join(projA, 'alpha-only-marker.ts'), '// alpha\n')
  writeFileSync(join(projB, 'beta-only-marker.ts'), '// beta\n')

  const { enableConfigs } = await import(join(REPO, 'src/utils/config/globalConfig.ts'))
  enableConfigs()
  const { runWithCwdOverride } = await import(join(REPO, 'src/utils/cwd.ts'))
  const suggestions = await import(join(REPO, 'src/hooks/fileSuggestions.ts'))

  const query = (cwd: string, partial: string): Promise<Array<{ displayText: string }>> =>
    runWithCwdOverride(cwd, () => suggestions.generateFileSuggestions(partial))

  let alphaHits: Array<{ displayText: string }> = []
  for (let i = 0; i < 100; i++) {
    alphaHits = await query(projA, 'alpha')
    if (alphaHits.length > 0) break
    await sleep(100)
  }
  check('project A finds its own file', alphaHits.some(s => s.displayText.includes('alpha-only-marker')), JSON.stringify(alphaHits))

  const firstUnderB = await query(projB, 'alpha')
  check("project B's FIRST answer never carries project A's paths", !firstUnderB.some(s => s.displayText.includes('alpha-only-marker')), JSON.stringify(firstUnderB))

  let betaHits: Array<{ displayText: string }> = []
  for (let i = 0; i < 100; i++) {
    betaHits = await query(projB, 'beta')
    if (betaHits.length > 0) break
    await sleep(100)
  }
  check('project B finds its own file after the rebuild', betaHits.some(s => s.displayText.includes('beta-only-marker')), JSON.stringify(betaHits))
  const alphaUnderB = await query(projB, 'alpha')
  check("project A's paths never resurface under B", !alphaUnderB.some(s => s.displayText.includes('alpha-only-marker')), JSON.stringify(alphaUnderB))
}

console.log('\n── §3 timers ──')
{
  const typeahead = await import(join(REPO, 'src/hooks/useTypeahead.tsx'))
  check('census starts at zero', typeahead.typeaheadTimerCensus() === 0, String(typeahead.typeaheadTimerCensus()))
  let fired = false
  const timer = typeahead.armTypeaheadTimer(() => {
    fired = true
  }, 30)
  check('an armed debounce is counted', typeahead.typeaheadTimerCensus() === 1)
  typeahead.disarmTypeaheadTimer(timer)
  check('a disarmed debounce leaves the census (and never fires)', typeahead.typeaheadTimerCensus() === 0 && !fired)
  typeahead.armTypeaheadTimer(() => {
    fired = true
  }, 20)
  await sleep(80)
  check('a fired debounce leaves the census', typeahead.typeaheadTimerCensus() === 0 && fired)

  const hookSrc = readFileSync(join(REPO, 'src/hooks/useTypeahead.tsx'), 'utf8')
  check('unmount disarms both fetch timers (the cleanup effect)', /useEffect\(\s*\(\) => \(\) => \{\s*cancelFileFetch\(\)\s*cancelChannelFetch\(\)/m.test(hookSrc))
  check('both arm sites ride the census', (hookSrc.match(/armTypeaheadTimer\(/g) ?? []).length >= 3)

  const indexSrc = readFileSync(join(REPO, 'src/hooks/fileSuggestions.ts'), 'utf8')
  check('the refresh walk deadline is disarmed in finally', /finally \{\s*clearTimeout\(timer\)\s*refreshInFlight = false/m.test(indexSrc))
  check('the stale-project guard answers empty, never another project', indexSrc.includes('staleProject') && indexSrc.includes('return staleProject ? [] : topLevelListing()'))
  check('the cache reset clears the project key', /ignoreCache = null\s*\n\s*indexKey = null/m.test(indexSrc))
}

console.log('\n── §3b worktree gitdir + tracked-skip ──')
{
  const { resolveGitDir } = await import(join(REPO, 'src/hooks/fileSuggestions.ts'))
  const { execFileSync } = await import('node:child_process')
  const repoDir = join(SCRATCH, 'gitdir-main')
  const wtDir = join(SCRATCH, 'gitdir-linked')
  mkdirSync(repoDir, { recursive: true })
  const git = (args: string[], cwd: string): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: SCRATCH } })
  }
  git(['init', '-q'], repoDir)
  git(['-c', 'user.email=prover@local', '-c', 'user.name=prover', 'commit', '-q', '--allow-empty', '-m', 'seed'], repoDir)
  git(['worktree', 'add', '-q', wtDir], repoDir)
  const mainGitDir = resolveGitDir(repoDir)
  const linkedGitDir = resolveGitDir(wtDir)
  check('a main worktree resolves its own .git directory', mainGitDir === join(repoDir, '.git'), String(mainGitDir))
  check(
    'a LINKED worktree resolves through the gitdir pointer to its per-worktree git dir',
    linkedGitDir !== null && linkedGitDir.includes(join('.git', 'worktrees')) && existsSync(join(linkedGitDir, 'index')),
    String(linkedGitDir),
  )
  check('a non-repo answers null, never a throw', resolveGitDir(join(SCRATCH, 'no-such-repo')) === null)

  const indexSrc = readFileSync(join(REPO, 'src/hooks/fileSuggestions.ts'), 'utf8')
  check('the index-mtime read routes through the resolved git dir', indexSrc.includes("statSync(join(gitDir, 'index')).mtimeMs") && !indexSrc.includes("join(gitRoot, '.git', 'index')"))
  check(
    'an unmoved index skips the tracked ls-files and refreshes ONLY the untracked merge',
    /if \(gitRoot !== null && indexUnchanged\) \{[\s\S]{0,400}kickUntrackedMerge\(gitRoot, cwd, startGeneration, keyAtStart\)[\s\S]{0,200}return/.test(indexSrc),
  )
  check('the skip road demands a live mtime AND a standing tracked list', indexSrc.includes('indexUnchanged = mtime !== null && !mtimeChanged && trackedOnly !== null'))
  check('an emptied untracked answer re-trues a standing merged index to the tracked list', /if \(mergedSignature !== null\) buildIndexFrom\(\[\.\.\.trackedOnly\], false, keyAtStart\)/.test(indexSrc))
}

console.log('\n── §4 middle truncation ──')
{
  const { truncatePathMiddle } = await import(join(REPO, 'src/utils/truncate.ts'))
  const posix = 'src/components/prompt-input/PromptInputFooterSuggestions.tsx'
  const win32 = 'src\\components\\prompt-input\\PromptInputFooterSuggestions.tsx'
  const budget = 44
  const posixShown = truncatePathMiddle(posix, budget)
  const win32Shown = truncatePathMiddle(win32, budget)
  check('posix spelling keeps the root and the filename around the ellipsis',
    posixShown.startsWith('src/') && posixShown.includes('…') && posixShown.endsWith('/PromptInputFooterSuggestions.tsx'), posixShown)
  check('win32 spelling keeps the root and the filename around the ellipsis',
    win32Shown.startsWith('src\\') && win32Shown.includes('…') && win32Shown.endsWith('\\PromptInputFooterSuggestions.tsx'), win32Shown)
  check('win32 spelling never degrades to a leading ellipsis', !win32Shown.startsWith('…'), win32Shown)
  check('both spellings truncate to the same width discipline', posixShown.length <= budget && win32Shown.length <= budget, `${posixShown.length}/${win32Shown.length}`)
}

console.log(failures === 0 ? '\n✅ SUGGESTION PLATFORM + PROJECT LAWS PROVEN' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
