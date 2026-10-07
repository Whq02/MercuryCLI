#!/usr/bin/env bun
import { plugin } from 'bun'
import { proofHome } from '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})

const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
delete process.env.NODE_ENV
delete process.env.MERCURY_SHELL_ENGINE
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'git-rules-')))

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(72) + '\n' + t)

writeFileSync(join(proofHome, 'settings.json'), '{}')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { setCwdState } = await import('../../src/bootstrap/state.ts')
const { getIsGit } = await import('../../src/utils/git.ts')
const { getGitStatus, getSystemContext } = await import('../../src/context.ts')
const gitRulesText = ((await import('../../src/utils/gitRules.ts').catch(() => null)) as { gitRulesText?: () => string } | null)?.gitRulesText ?? (() => 'no src/utils/gitRules.ts on this tree')
const { getSimplePrompt } = await import('../../src/tools/BashTool/prompt.ts')
const { appendSystemContext } = await import('../../src/utils/api.ts')

const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@example.invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@example.invalid' } })
}
const fresh = async (cwd: string): Promise<Record<string, string>> => {
  setCwdState(cwd)
  getIsGit.cache.clear?.()
  getGitStatus.cache.clear?.()
  getSystemContext.cache.clear?.()
  resetSettingsCache()
  return getSystemContext()
}

const EXPECTED_RULES = [
  'For git commands: prefer creating a new commit over amending; consider a safer alternative before any destructive operation (`git reset --hard`, `git push --force`, `git checkout --`); never skip hooks (`--no-verify`) or bypass signing (`--no-gpg-sign`, or an inline config disabling gpg signing) unless explicitly asked, and investigate a hook failure rather than working around it.',
  '# Committing changes with git',
  'Only create a commit when the user asks for one; if it is unclear, ask first.',
  'You may issue several tool calls in one response; batch independent commands that are likely to succeed in parallel.',
  'Git safety protocol: never update git config; never run a destructive git command (`push --force`, `reset --hard`, `checkout .`, `restore .`, `clean -f`, `branch -D`) unless explicitly asked; never bypass hooks (`--no-verify`, `--no-gpg-sign`); never force-push to `main`/`master`, and warn when asked to; amend only on an explicit request — otherwise every commit is a NEW one (after a failed pre-commit hook there IS no new commit, so an amend would rewrite the previous one and can destroy work); stage named files rather than the sweep-everything forms `git add -A`/`git add .`, which drag in secrets and large binaries; commit only when asked.',
  "Commit workflow: (1) in parallel, run `git status` (never with `-uall`, which can exhaust memory on large repos), a diff of staged and unstaged changes, and a log to learn the repository's message style, each through the Bash tool; (2) read every staged change and compose the message, choosing the verb correctly (add = wholly new, update = an enhancement, fix = a bug fix), avoiding likely-secret files (`.env`, `credentials.json`) and warning if the user asks for them, keeping the message to one or two sentences focused on WHY; (3) in parallel, stage the relevant untracked files and create the commit with the attribution trailer appended, then run `git status` sequentially after the commit to verify; (4) on a pre-commit hook failure, fix the problem and create a NEW commit.",
  "Never run additional exploration commands beyond the git ones; never create tasks or launch agents from here; do not push unless asked; never use git's interactive `-i` flag (rebase/add), since interactive input is unsupported; do not pass `--no-edit` to `git rebase`; nothing staged means no commit at all (never an empty one); the commit message always travels in a quoted heredoc.",
  'Worked example (heredoc form with the attribution trailer):\n```\ngit commit -m "$(cat <<\'EOF\'\nfix: correct the off-by-one in the parser\n\nCo-Authored-By: Mercury <https://mercury-cli.ai>\nEOF\n)"\n```',
  '# Creating pull requests',
  'Every GitHub task — issues, pull requests, checks, releases, resolving a GitHub URL — goes through `gh` run by the Bash tool.',
  'PR workflow: (1) in parallel, run status (again never `-uall`), a diff, a check of whether the branch tracks a remote and is up to date, and both a log and a three-dot diff against the base branch to see the whole branch history; (2) read every commit the PR will carry, not only the newest, and draft a title under 70 characters with the detail in the body; (3) in parallel, create the branch if needed, push with `-u` if needed, and create the PR with `gh pr create` using a heredoc body.',
  'Worked example (PR body):\n```\ngh pr create --title "Fix the parser off-by-one" --body "$(cat <<\'EOF\'\n## Summary\n- corrects the boundary in the token walk\n- adds a regression test\n\n## Test plan\n- [ ] unit tests pass\n- [ ] manual check on the sample corpus\n\nGenerated with [Mercury CLI](https://mercury-cli.ai)\nEOF\n)"\n```',
  'Task items and agent launches stay out of this flow; finish by handing the user the PR URL to open.',
  'Other common operations: view PR comments through `gh api repos/<owner>/<repo>/pulls/<number>/comments`.',
].join('\n\n')

section('§1 a git repository: the system context carries gitRules beside gitStatus, word for word the .28 Bash text')
const repo = join(SCRATCH, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '-q', '-b', 'main'])
writeFileSync(join(repo, 'README.md'), 'proof\n')
git(repo, ['add', 'README.md'])
git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
const inRepo = await fresh(repo)
check('gitStatus is present in a repository', typeof inRepo.gitStatus === 'string' && inRepo.gitStatus.includes('Current branch: main'), JSON.stringify(Object.keys(inRepo)))
check('gitRules is present beside it', typeof inRepo.gitRules === 'string', JSON.stringify(Object.keys(inRepo)))
check('gitRules carries the commit workflow heading', (inRepo.gitRules ?? '').includes('# Committing changes with git'))
check('gitRules carries the pull-request workflow heading', (inRepo.gitRules ?? '').includes('# Creating pull requests'))
check('gitRules carries the attribution trailer from the attribution texts', (inRepo.gitRules ?? '').includes('Co-Authored-By: Mercury <https://mercury-cli.ai>'))
check('gitRules carries the git bullet first', (inRepo.gitRules ?? '').startsWith('For git commands: prefer creating a new commit over amending;'))
check('gitRules is the .28 text word for word: the bullet, a blank line, the two sections (3,807 bytes with the default attribution)', inRepo.gitRules === EXPECTED_RULES && Buffer.byteLength(EXPECTED_RULES, 'utf8') === 3807, `${Buffer.byteLength(inRepo.gitRules ?? '', 'utf8')} bytes`)
check('the keys come in the order gitStatus, gitRules', JSON.stringify(Object.keys(inRepo)) === JSON.stringify(['gitStatus', 'gitRules']), JSON.stringify(Object.keys(inRepo)))
const rendered = appendSystemContext(['the prompt'], inRepo)
check('the system block renders gitRules: after gitStatus:', rendered.length === 2 && /gitStatus: [\s\S]*\ngitRules: For git commands:/.test(rendered[1] ?? ''), JSON.stringify(rendered[1]?.slice(0, 120)))
check('the Bash description carries no git workflow in a repository', !getSimplePrompt(null).includes('# Committing changes with git') && !getSimplePrompt(null).includes('For git commands:'))

section('§2 outside a repository: no gitRules, no gitStatus')
const plain = join(SCRATCH, 'plain')
mkdirSync(plain, { recursive: true })
const outside = await fresh(plain)
check('no gitStatus outside a repository', outside.gitStatus === undefined, JSON.stringify(Object.keys(outside)))
check('no gitRules outside a repository', outside.gitRules === undefined, JSON.stringify(Object.keys(outside)))
check('the Bash description carries no git workflow outside a repository either', !getSimplePrompt(null).includes('# Committing changes with git'))

section('§3 briefs.git: false switches the rules off in their new place')
writeFileSync(join(proofHome, 'settings.json'), JSON.stringify({ briefs: { git: false } }))
const switchedOff = await fresh(repo)
check('with briefs.git false the repository session carries no gitStatus', switchedOff.gitStatus === undefined, JSON.stringify(Object.keys(switchedOff)))
check('…and no gitRules', switchedOff.gitRules === undefined, JSON.stringify(Object.keys(switchedOff)))
check('gitRulesText() itself is empty under briefs.git false', gitRulesText() === '')
check('the Bash description carries no git workflow with briefs.git false', !getSimplePrompt(null).includes('# Committing changes with git'))

section('§4 the attribution settings still shape the rules')
writeFileSync(join(proofHome, 'settings.json'), JSON.stringify({ credit: { mercury: false } }))
const uncredited = await fresh(repo)
check('with credit.mercury false the trailer and the worked commit example leave the rules', typeof uncredited.gitRules === 'string' && !uncredited.gitRules.includes('Co-Authored-By') && !uncredited.gitRules.includes('Worked example (heredoc form') && uncredited.gitRules.includes('create the commit, then run `git status`'), uncredited.gitRules?.slice(0, 80))
check('…and the PR body example carries no attribution line', typeof uncredited.gitRules === 'string' && !uncredited.gitRules.includes('Generated with [Mercury CLI]'))
writeFileSync(join(proofHome, 'settings.json'), JSON.stringify({ credit: { lines: { commit: 'Signed-off-by: Proof <proof@example.invalid>', pr: 'Made by Proof' } } }))
const custom = await fresh(repo)
check('custom credit lines land in the trailer example and the PR body', typeof custom.gitRules === 'string' && custom.gitRules.includes('Signed-off-by: Proof <proof@example.invalid>') && custom.gitRules.includes('Made by Proof'), custom.gitRules?.slice(-200))

for (const dir of [SCRATCH, proofHome]) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    continue
  }
}
console.log(`\n${failures === 0 ? `ALL GREEN (${checks} checks)` : `${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
