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
  'Git in this repository: commit only when the user asks for one, and never push unless asked. Never change the git config. A failing hook is investigated and fixed, never skipped (no `--no-verify`, no `--no-gpg-sign`); after a failed pre-commit hook there is no new commit, so the fix lands in a fresh commit, never an amend. Amend, force-push, `reset --hard`, `checkout .`, `restore .`, `clean -f` and `branch -D` only on an explicit ask. Stage named files, never `git add -A` or `git add .`; `git status` never with `-uall`; nothing staged means no commit. Git\'s interactive `-i` flag and `rebase --no-edit` do not work here, and a commit message travels in a quoted heredoc with the attribution trailer:',
  '```\ngit commit -m "$(cat <<\'EOF\'\n<the subject line>\n\nCo-Authored-By: Mercury <https://mercury-cli.ai>\nEOF\n)"\n```',
  'GitHub work — issues, pull requests, checks, releases, a GitHub URL — goes through `gh` run by the Bash tool; a pull request\'s body is a heredoc too, ending with `Generated with [Mercury CLI](https://mercury-cli.ai)`, and the user gets the PR URL to open.',
].join('\n\n')

section('§1 a git repository: the system context carries gitRules beside gitStatus — the git facts no other section carries, once')
const repo = join(SCRATCH, 'repo')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '-q', '-b', 'main'])
writeFileSync(join(repo, 'README.md'), 'proof\n')
git(repo, ['add', 'README.md'])
git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'])
const inRepo = await fresh(repo)
check('gitStatus is present in a repository', typeof inRepo.gitStatus === 'string' && inRepo.gitStatus.includes('Current branch: main'), JSON.stringify(Object.keys(inRepo)))
check('gitRules is present beside it', typeof inRepo.gitRules === 'string', JSON.stringify(Object.keys(inRepo)))
check('gitRules carries the hook fact (investigated, never skipped; a fresh commit after a failed hook)', (inRepo.gitRules ?? '').includes('never skipped (no `--no-verify`, no `--no-gpg-sign`)') && (inRepo.gitRules ?? '').includes('a fresh commit, never an amend'))
check('gitRules carries the gh fact for GitHub work', (inRepo.gitRules ?? '').includes('goes through `gh` run by the Bash tool'))
check('gitRules carries the attribution trailer and the PR line from the attribution texts', (inRepo.gitRules ?? '').includes('Co-Authored-By: Mercury <https://mercury-cli.ai>') && (inRepo.gitRules ?? '').includes('Generated with [Mercury CLI](https://mercury-cli.ai)'))
check('gitRules opens on the commit rule', (inRepo.gitRules ?? '').startsWith('Git in this repository: commit only when the user asks for one'))
check('gitRules repeats nothing the Acting-with-care section or the batching rule carries (no workflow procedures, no destructive-operation sermon, no headings)', !(inRepo.gitRules ?? '').includes('# Committing changes with git') && !(inRepo.gitRules ?? '').includes('Commit workflow') && !(inRepo.gitRules ?? '').includes('batch independent commands') && !(inRepo.gitRules ?? '').includes('PR workflow'))
check('gitRules is the text word for word: the rule, the heredoc, the GitHub line (1,080 bytes with the default attribution)', inRepo.gitRules === EXPECTED_RULES && Buffer.byteLength(EXPECTED_RULES, 'utf8') === 1080, `${Buffer.byteLength(inRepo.gitRules ?? '', 'utf8')} bytes`)
check('the keys come in the order gitStatus, gitRules', JSON.stringify(Object.keys(inRepo)) === JSON.stringify(['gitStatus', 'gitRules']), JSON.stringify(Object.keys(inRepo)))
const rendered = appendSystemContext(['the prompt'], inRepo)
check('the system block renders gitRules: after gitStatus:', rendered.length === 2 && /gitStatus: [\s\S]*\ngitRules: Git in this repository:/.test(rendered[1] ?? ''), JSON.stringify(rendered[1]?.slice(0, 120)))
check('the Bash description carries no git workflow in a repository', !getSimplePrompt(null).includes('# Committing changes with git') && !getSimplePrompt(null).includes('Git in this repository:'))

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
check('with credit.mercury false the trailer leaves the rules and the heredoc shows a bare message', typeof uncredited.gitRules === 'string' && !uncredited.gitRules.includes('Co-Authored-By') && !uncredited.gitRules.includes('with the attribution trailer') && uncredited.gitRules.includes('<the subject line>\nEOF'), uncredited.gitRules?.slice(0, 80))
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
