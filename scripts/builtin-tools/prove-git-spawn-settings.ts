#!/usr/bin/env bun
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'git-spawn-settings-'))
process.env.HOME = home
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.GIT_CONFIG_GLOBAL = join(home, 'global-config')
process.env.GIT_CONFIG_NOSYSTEM = '1'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { gitDiff, gitStatus } = await import('../../src/services/gitGraph/observe.ts')
const { fetchGitDiffHunksFor } = await import('../../src/utils/gitDiff.ts')
const { resolveConflict, stageSelection } = await import('../../src/services/gitGraph/plan.ts')
const { gitAdapter } = await import('../../src/services/resources/adapters/git.ts')
const { parseMercuryRef } = await import('../../src/services/resources/contracts.ts')
const { processMainOwner } = await import('../../src/services/run/resolveOwner.ts')
const { execFileNoThrowWithCwd } = await import('../../src/utils/execFileNoThrow.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const root = join(home, 'repo')
mkdirSync(root, { recursive: true })
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 'proof',
  GIT_AUTHOR_EMAIL: 'proof@local',
  GIT_COMMITTER_NAME: 'proof',
  GIT_COMMITTER_EMAIL: 'proof@local',
}
const plain = (args: string[], cwd = root): string => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const marker = (name: string) => join(home, `${name}.marker`)
const clear = (...names: string[]) => names.forEach(name => rmSync(marker(name), { force: true }))
const marked = (name: string) => existsSync(marker(name))
const script = (path: string, name: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(marker(name))}\n${body}\n`)
  if (process.platform !== 'win32') execFileSync('chmod', ['+x', path])
}
const forbidden = ['diff', 'textconv', 'monitor', 'local']
const clearForbidden = () => clear(...forbidden)
const noConfiguredDiffHelpers = () => ['diff', 'textconv', 'monitor'].every(name => !marked(name))
const skipLine = 'filter local skipped: its command lives inside this repository'
const credentialServer = createServer((_req, res) => {
  res.writeHead(401, { 'www-authenticate': 'Basic realm="proof"' })
  res.end('credentials required')
})

try {
  plain(['init', '--quiet', '--initial-branch=main'])
  writeFileSync(join(root, '.gitattributes'), 'local.txt diff=txt filter=local\nexternal.txt filter=external\n')
  writeFileSync(join(root, 'local.txt'), 'one\ntwo\n')
  writeFileSync(join(root, 'external.txt'), 'red\nblue\n')
  plain(['add', '.'])
  plain(['commit', '--quiet', '-m', 'seed'])
  mkdirSync(join(root, 'helpers'), { recursive: true })
  script(join(root, 'helpers', 'local.sh'), 'local', 'cat')
  script(join(home, 'diff.sh'), 'diff', 'exit 0')
  script(join(home, 'textconv.sh'), 'textconv', 'cat "$1"')
  script(join(home, 'monitor.sh'), 'monitor', 'exit 0')
  script(join(home, 'external.sh'), 'external', 'case "$1" in clean) sed "s/^/external:/" ;; smudge) sed "s/^external://" ;; esac')
  script(join(home, 'network.sh'), 'network', 'exit 1')
  script(join(home, 'credential.sh'), 'credential', 'printf "username=proof\\npassword=proof\\n"\nexit 0')
  plain(['config', 'diff.external', join(home, 'diff.sh')])
  plain(['config', 'diff.txt.textconv', join(home, 'textconv.sh')])
  plain(['config', 'core.fsmonitor', join(home, 'monitor.sh')])
  plain(['config', 'filter.local.clean', './helpers/local.sh clean'])
  plain(['config', 'filter.local.smudge', './helpers/local.sh smudge'])
  plain(['config', 'filter.external.clean', `${join(home, 'external.sh')} clean`])
  plain(['config', 'filter.external.smudge', `${join(home, 'external.sh')} smudge`])
  writeFileSync(join(root, 'local.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(root, 'external.txt'), 'red\nblue\ngreen\n')

  clearForbidden()
  plain(['diff', 'HEAD'])
  check('plain git runs the configured diff command', marked('diff'))
  clearForbidden()

  const worktree = gitDiff(root, { scope: 'worktree' })
  check('worktree diff keeps its hunk and runs no configured helper', !('state' in worktree) && worktree.hunks.some(h => h.file === 'local.txt' && h.lines.includes('+three')) && noConfiguredDiffHelpers(), JSON.stringify(worktree))
  clearForbidden()
  const head = plain(['rev-parse', 'HEAD']).trim()
  const commit = gitDiff(root, { scope: 'commit', ref: head })
  check('commit diff keeps its content and runs no configured helper', !('state' in commit) && commit.hunks.some(h => h.file === 'local.txt' && h.lines.includes('+two')) && noConfiguredDiffHelpers(), JSON.stringify(commit))
  clearForbidden()
  const inspected = await gitAdapter.resolve(parseMercuryRef('mercury://git/diff')!, { cwd: root, owner: processMainOwner() })
  check('Inspect returns the same diff without configured helpers', inspected.state === 'ok' && JSON.stringify(inspected.resource.structured).includes('local.txt') && noConfiguredDiffHelpers(), JSON.stringify(inspected))
  clearForbidden()
  const hunks = await fetchGitDiffHunksFor({ cwd: root, args: ['HEAD'] })
  check('hunk fetch returns local.txt without configured helpers', hunks.has('local.txt') && noConfiguredDiffHelpers(), JSON.stringify([...hunks.keys()]))
  clearForbidden()
  const status = gitStatus(root)
  check('status reads the tree without the file monitor', !('state' in status) && status.files.some(f => f.path === 'local.txt') && noConfiguredDiffHelpers(), JSON.stringify(status))

  clearForbidden()
  const stagedLocal = stageSelection(root, ['local.txt'])
  check('repository-local filter is skipped with the exact result line', stagedLocal.state === 'ok' && stagedLocal.detail.includes(skipLine) && !marked('local'), JSON.stringify(stagedLocal))
  check('the file still stages its real content', plain(['show', ':local.txt']) === 'one\ntwo\nthree\n', plain(['show', ':local.txt']))

  clear('external')
  const stagedExternal = stageSelection(root, ['external.txt'])
  const externalBlob = plain(['show', ':external.txt'])
  check('external clean filter still runs and shapes the staged blob', stagedExternal.state === 'ok' && marked('external') && externalBlob === 'external:red\nexternal:blue\nexternal:green\n', `${JSON.stringify(stagedExternal)} ${externalBlob}`)
  check('external filter is not named as skipped', stagedExternal.state === 'ok' && !stagedExternal.detail.includes('filter external skipped'), JSON.stringify(stagedExternal))
  clear('external')
  rmSync(join(root, 'external.txt'))
  plain(['checkout', '--force', '--', 'external.txt'])
  check('external smudge filter round-trips the worktree content', marked('external') && readFileSync(join(root, 'external.txt'), 'utf8') === 'red\nblue\ngreen\n', readFileSync(join(root, 'external.txt'), 'utf8'))

  const conflict = join(home, 'conflict')
  mkdirSync(conflict, { recursive: true })
  plain(['init', '--quiet', '--initial-branch=main'], conflict)
  writeFileSync(join(conflict, '.gitattributes'), 'local.txt filter=local\n')
  writeFileSync(join(conflict, 'local.txt'), 'base\n')
  plain(['add', '.'], conflict)
  plain(['commit', '--quiet', '-m', 'base'], conflict)
  plain(['checkout', '--quiet', '-b', 'side'], conflict)
  writeFileSync(join(conflict, 'local.txt'), 'side\n')
  plain(['commit', '--quiet', '-am', 'side'], conflict)
  plain(['checkout', '--quiet', 'main'], conflict)
  writeFileSync(join(conflict, 'local.txt'), 'main\n')
  plain(['commit', '--quiet', '-am', 'main'], conflict)
  try { plain(['merge', '--quiet', 'side'], conflict) } catch {}
  mkdirSync(join(conflict, 'helpers'), { recursive: true })
  script(join(conflict, 'helpers', 'local.sh'), 'local', 'cat')
  plain(['config', 'filter.local.clean', './helpers/local.sh clean'], conflict)
  plain(['config', 'filter.local.smudge', './helpers/local.sh smudge'], conflict)
  clear('local')
  const resolved = resolveConflict(processMainOwner(), conflict, 'local.txt', { take: 'ours' })
  check('conflict checkout and staging skip the repository-local filter', resolved.state === 'ok' && resolved.detail.includes(skipLine) && !marked('local'), JSON.stringify(resolved))
  check('conflict resolution still stages the selected content', plain(['show', ':local.txt'], conflict) === 'main\n', plain(['show', ':local.txt'], conflict))

  plain(['remote', 'add', 'origin', 'ssh://127.0.0.1:1/repository'])
  plain(['config', 'core.sshCommand', join(home, 'network.sh')])
  clear('network')
  try { plain(['ls-remote', 'origin']) } catch {}
  check('plain ls-remote honors the repository SSH command', marked('network'))
  clear('network')
  await execFileNoThrowWithCwd('git', ['ls-remote', 'origin'], { cwd: root, timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  check('Mercury ls-remote does not use the repository SSH command', !marked('network'))

  const credentialPort = await new Promise<number>(resolvePort => credentialServer.listen(0, '127.0.0.1', () => {
    const address = credentialServer.address()
    resolvePort(typeof address === 'object' && address !== null ? address.port : 0)
  }))
  plain(['remote', 'set-url', 'origin', `http://127.0.0.1:${credentialPort}/repository`])
  plain(['config', 'credential.helper', join(home, 'credential.sh')])
  clear('credential')
  await new Promise<void>(resolveControl => {
    execFile('git', ['ls-remote', 'origin'], { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 5_000 }, () => resolveControl())
  })
  check('plain ls-remote honors the repository credential helper', marked('credential'))
  clear('credential')
  await execFileNoThrowWithCwd('git', ['ls-remote', 'origin'], { cwd: root, timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  check('Mercury ls-remote does not use the repository credential helper', !marked('credential'))
} finally {
  credentialServer.close()
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? 'GIT SPAWN SETTINGS: ALL GREEN' : `GIT SPAWN SETTINGS: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
