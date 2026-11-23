#!/usr/bin/env bun
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { delimiter, join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'git-spawn-settings-'))
process.env.HOME = home
process.env.MERCURY_CONFIG_DIR = join(home, 'config')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.GIT_CONFIG_GLOBAL = join(home, 'global-config')
process.env.GIT_CONFIG_NOSYSTEM = '1'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { gitDiff, gitStatus } = await import('../../src/platform/git-graph/observe.ts')
const { fetchGitDiffHunksFor } = await import('../../src/screen/diff/gitDiff.ts')
const { resolveConflict, stageSelection } = await import('../../src/platform/git-graph/plan.ts')
const { applyResolution, prepareResolution, readConflictRegions } = await import('../../src/platform/git-graph/conflictRegions.ts')
const { gitAdapter } = await import('../../src/integrations/resources/adapters/git.ts')
const { parseMercuryRef } = await import('../../src/integrations/resources/contracts.ts')
const { processMainOwner } = await import('../../src/engine/run-owner/resolveOwner.ts')
const { execFileNoThrowWithCwd } = await import('../../src/platform/processes/execFileNoThrow.ts')
const { gitArgs } = await import('../../src/platform/git/spawnArgs.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const spawnHint = 'change gitArgs and spawnShape in src/platform/git/spawnArgs.ts, which add the no-helper settings to every Mercury git spawn'
const planHint = 'change stageSelection and resolveConflict in src/platform/git-graph/plan.ts and gitFilterSkipMessages in src/platform/git/spawnArgs.ts'
const fixtureHint = 'plain git in this proof did not behave as the proof expects, so check the git on PATH and the fixture setup in this file'
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
const posix = (path: string): string => path.replaceAll('\\', '/')
const marker = (name: string) => join(home, `${name}.marker`)
const clear = (...names: string[]) => names.forEach(name => rmSync(marker(name), { force: true }))
const marked = (name: string) => existsSync(marker(name))
const script = (path: string, name: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$0 $*" >> ${JSON.stringify(posix(marker(name)))}\n${body}\n`)
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
  plain(['config', 'diff.external', posix(join(home, 'diff.sh'))])
  plain(['config', 'diff.txt.textconv', posix(join(home, 'textconv.sh'))])
  plain(['config', 'core.fsmonitor', posix(join(home, 'monitor.sh'))])
  plain(['config', 'filter.local.clean', './helpers/local.sh clean'])
  plain(['config', 'filter.local.smudge', './helpers/local.sh smudge'])
  plain(['config', 'filter.external.clean', `${posix(join(home, 'external.sh'))} clean`])
  plain(['config', 'filter.external.smudge', `${posix(join(home, 'external.sh'))} smudge`])
  writeFileSync(join(root, 'local.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(root, 'external.txt'), 'red\nblue\ngreen\n')

  clearForbidden()
  plain(['diff', 'HEAD'])
  check('plain git runs the configured diff command', marked('diff'), fixtureHint)
  clearForbidden()

  const worktree = gitDiff(root, { scope: 'worktree' })
  check('worktree diff keeps its hunk and runs no configured helper', !('state' in worktree) && worktree.hunks.some(h => h.file === 'local.txt' && h.lines.includes('+three')) && noConfiguredDiffHelpers(), `${JSON.stringify(worktree)} | ${spawnHint}; gitDiff is in src/platform/git-graph/observe.ts`)
  clearForbidden()
  const head = plain(['rev-parse', 'HEAD']).trim()
  const commit = gitDiff(root, { scope: 'commit', ref: head })
  check('commit diff keeps its content and runs no configured helper', !('state' in commit) && commit.hunks.some(h => h.file === 'local.txt' && h.lines.includes('+two')) && noConfiguredDiffHelpers(), `${JSON.stringify(commit)} | ${spawnHint}; gitDiff is in src/platform/git-graph/observe.ts`)
  clearForbidden()
  const inspected = await gitAdapter.resolve(parseMercuryRef('mercury://git/diff')!, { cwd: root, owner: processMainOwner() })
  check('Inspect returns the same diff without configured helpers', inspected.state === 'ok' && JSON.stringify(inspected.resource.structured).includes('local.txt') && noConfiguredDiffHelpers(), `${JSON.stringify(inspected)} | ${spawnHint}; the Inspect git diff resolves in src/integrations/resources/adapters/git.ts`)
  clearForbidden()
  const hunks = await fetchGitDiffHunksFor({ cwd: root, args: ['HEAD'] })
  check('hunk fetch returns local.txt without configured helpers', hunks.has('local.txt') && noConfiguredDiffHelpers(), `${JSON.stringify([...hunks.keys()])} | ${spawnHint}; fetchGitDiffHunksFor is in src/screen/diff/gitDiff.ts`)
  clearForbidden()
  const status = gitStatus(root)
  check('status reads the tree without the file monitor', !('state' in status) && status.files.some(f => f.path === 'local.txt') && noConfiguredDiffHelpers(), `${JSON.stringify(status)} | ${spawnHint}; gitStatus is in src/platform/git-graph/observe.ts`)

  clearForbidden()
  const stagedLocal = stageSelection(root, ['local.txt'])
  check('repository-local filter is skipped with the exact result line', stagedLocal.state === 'ok' && stagedLocal.detail.includes(skipLine) && !marked('local'), `${JSON.stringify(stagedLocal)} | ${planHint}`)
  check('the file still stages its real content', plain(['show', ':local.txt']) === 'one\ntwo\nthree\n', `${plain(['show', ':local.txt'])} | stageSelection in src/platform/git-graph/plan.ts must still stage the file content when it skips the filter`)

  clear('external')
  const stagedExternal = stageSelection(root, ['external.txt'])
  const externalBlob = plain(['show', ':external.txt'])
  check('external clean filter still runs and shapes the staged blob', stagedExternal.state === 'ok' && marked('external') && externalBlob === 'external:red\nexternal:blue\nexternal:green\n', `${JSON.stringify(stagedExternal)} ${externalBlob} | ${planHint}; a filter outside the repository must not be disabled`)
  check('external filter is not named as skipped', stagedExternal.state === 'ok' && !stagedExternal.detail.includes('filter external skipped'), `${JSON.stringify(stagedExternal)} | gitFilterSkipMessages in src/platform/git/spawnArgs.ts names only filters whose command lives inside the repository`)
  clear('external')
  rmSync(join(root, 'external.txt'))
  plain(['checkout', '--force', '--', 'external.txt'])
  check('external smudge filter round-trips the worktree content', marked('external') && readFileSync(join(root, 'external.txt'), 'utf8') === 'red\nblue\ngreen\n', `${readFileSync(join(root, 'external.txt'), 'utf8')} | ${spawnHint}; the external smudge filter must stay active on checkout`)
  clear('local', 'external')
  const filteredLocal = plain(gitArgs(['cat-file', '--filters', '--path=local.txt', ':local.txt'], root))
  check('filtered blob reads skip the repository-local smudge filter', !marked('local') && filteredLocal === 'one\ntwo\nthree\n', `${filteredLocal} | ${spawnHint}; the cat-file --filters branch of gitArgs must add the skip setting for repository-local filters`)
  const filteredExternal = plain(gitArgs(['cat-file', '--filters', '--path=external.txt', ':external.txt'], root))
  check('filtered blob reads retain the external smudge conversion', marked('external') && filteredExternal === 'red\nblue\ngreen\n', `${filteredExternal} | ${spawnHint}; only repository-local filters may be skipped`)
  check('ordinary cat-file blob reads carry no new filter configuration', !gitArgs(['cat-file', 'blob', ':local.txt'], root).some(word => word.startsWith('filter.')), `${spawnHint}; FILTER_COMMANDS in src/platform/git/spawnArgs.ts must not cover cat-file blob`)

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
  check('conflict checkout and staging skip the repository-local filter', resolved.state === 'ok' && resolved.detail.includes(skipLine) && !marked('local'), `${JSON.stringify(resolved)} | ${planHint}`)
  check('conflict resolution still stages the selected content', plain(['show', ':local.txt'], conflict) === 'main\n', `${plain(['show', ':local.txt'], conflict)} | resolveConflict in src/platform/git-graph/plan.ts must still stage the chosen side`)

  const regions = join(home, 'regions')
  mkdirSync(regions, { recursive: true })
  plain(['init', '--quiet', '--initial-branch=main'], regions)
  plain(['config', 'filter.external.clean', `${posix(join(home, 'external.sh'))} clean`], regions)
  plain(['config', 'filter.external.smudge', `${posix(join(home, 'external.sh'))} smudge`], regions)
  writeFileSync(join(regions, '.gitattributes'), 'local.txt filter=local\nexternal.txt filter=external\n')
  const both = (text: string): void => ['local.txt', 'external.txt'].forEach(name => writeFileSync(join(regions, name), text))
  both('base\n')
  plain(['add', '.'], regions)
  plain(['commit', '--quiet', '-m', 'base'], regions)
  plain(['checkout', '--quiet', '-b', 'side'], regions)
  both('side\n')
  plain(['commit', '--quiet', '-am', 'side'], regions)
  plain(['checkout', '--quiet', 'main'], regions)
  both('main\n')
  plain(['commit', '--quiet', '-am', 'main'], regions)
  try { plain(['merge', '--quiet', 'side'], regions) } catch {}
  const takeOurs = async (name: string): Promise<string> => {
    const plan = prepareResolution(processMainOwner(), regions, readConflictRegions(processMainOwner(), regions, name).map(region => ({ region: region.id, take: 'ours' as const })))
    if ('reason' in plan) return plan.reason
    const out = await applyResolution(plan)
    return out.state === 'ok' ? out.detail : out.reason
  }
  clear('external', 'local')
  const regionExternal = await takeOurs('external.txt')
  check('a region resolution still runs an external clean filter on the staged blob, and names no filter as skipped', marked('external') && plain(['show', ':external.txt'], regions) === 'external:main\n' && regionExternal.includes('staged: external.txt') && !regionExternal.includes('skipped'), `${regionExternal} ${plain(['ls-files', '--stage'], regions)} | applyResolution in src/platform/git-graph/conflictRegions.ts and gitFilterSkipMessages in src/platform/git/spawnArgs.ts`)
  mkdirSync(join(regions, 'helpers'), { recursive: true })
  script(join(regions, 'helpers', 'local.sh'), 'local', 'sed "s/^/local:/"')
  plain(['config', 'filter.local.clean', './helpers/local.sh clean'], regions)
  plain(['config', 'filter.local.smudge', './helpers/local.sh smudge'], regions)
  clear('external', 'local')
  const regionLocal = await takeOurs('local.txt')
  check('a region resolution skips the repository-local filter, stages the resolved text itself and says so', !marked('local') && plain(['show', ':local.txt'], regions) === 'main\n' && regionLocal.includes('staged: local.txt') && regionLocal.includes(skipLine) && !regionLocal.includes('filter external skipped'), `${regionLocal} ${plain(['show', ':local.txt'], regions)} | applyResolution in src/platform/git-graph/conflictRegions.ts and gitFilterSkipMessages in src/platform/git/spawnArgs.ts`)

  plain(['remote', 'add', 'origin', 'ssh://127.0.0.1:1/repository'])
  plain(['config', 'core.sshCommand', posix(join(home, 'network.sh'))])
  clear('network')
  try { plain(['ls-remote', 'origin']) } catch {}
  check('plain ls-remote honors the repository SSH command', marked('network'), fixtureHint)
  clear('network')
  await execFileNoThrowWithCwd('git', ['ls-remote', 'origin'], { cwd: root, timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } })
  check('Mercury ls-remote does not use the repository SSH command', !marked('network'), `${spawnHint}; networkConfig sets core.sshCommand=ssh for ls-remote`)
  clear('network')
  try { plain(['remote', 'show', 'origin']) } catch {}
  check('plain remote show honors the repository SSH command', marked('network'), fixtureHint)
  clear('network')
  await execFileNoThrowWithCwd('git', ['remote', 'show', 'origin'], { cwd: root, timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } })
  check('Mercury remote show does not use the repository SSH command', !marked('network'), `${spawnHint}; networkConfig sets core.sshCommand=ssh for remote`)
  check('the network settings ride remote, pull, push, clone, submodule and archive as well as fetch and ls-remote', ['remote', 'pull', 'push', 'clone', 'submodule', 'archive', 'fetch', 'ls-remote'].every(command => gitArgs([command, 'origin'], root).includes('core.sshCommand=ssh')), `${spawnHint}; NETWORK_COMMANDS in src/platform/git/spawnArgs.ts must list every command in this check`)

  const credentialPort = await new Promise<number>(resolvePort => credentialServer.listen(0, '127.0.0.1', () => {
    const address = credentialServer.address()
    resolvePort(typeof address === 'object' && address !== null ? address.port : 0)
  }))
  plain(['remote', 'set-url', 'origin', `http://127.0.0.1:${credentialPort}/repository`])
  plain(['config', 'credential.helper', posix(join(home, 'credential.sh'))])
  clear('credential')
  await new Promise<void>(resolveControl => {
    execFile('git', ['ls-remote', 'origin'], { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }, timeout: 5_000 }, () => resolveControl())
  })
  check('plain ls-remote honors the repository credential helper', marked('credential'), fixtureHint)
  clear('credential')
  await execFileNoThrowWithCwd('git', ['ls-remote', 'origin'], { cwd: root, timeout: 5_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' } })
  check('Mercury ls-remote does not use the repository credential helper', !marked('credential'), `${spawnHint}; networkConfig must neutralise credential.helper for ls-remote`)
  check('before a repository askPass program is set, the network settings name none', !gitArgs(['ls-remote', 'origin'], root).some(word => word.startsWith('core.askPass=')), `${spawnHint}; the askPass setting is only added when the repository sets one`)
  plain(['config', 'core.askPass', posix(join(home, 'askpass.sh'))])
  check('a repository-scoped askPass program is replaced by the user\'s own, else none, on ls-remote, fetch and remote', ['ls-remote', 'fetch', 'remote'].every(command => gitArgs([command, 'origin'], root).includes('core.askPass=')), `${spawnHint}; networkConfig must replace a repository askPass program for ls-remote, fetch and remote`)

  if (process.platform === 'win32') console.log("  [SKIP] the eight rows of the stand-in git (the rig holds; a layout, filter-settings or config read that ends without an exit status, or gives no answer within its limit, does not stop the call; the control) — not read on Windows: the rows plant a shell-script git on PATH, which Windows does not start")
  else {
    const { gitExe } = await import('../../src/platform/git/gitExe.ts')
    const { gitArgsAsync, gitFilterSkipMessages } = await import('../../src/platform/git/spawnArgs.ts')
    const realGit = Bun.which('git') ?? 'git'
    const fake = join(home, 'fake-git')
    mkdirSync(fake)
    writeFileSync(join(fake, 'git'), `#!/bin/sh\nhere="$(dirname "$0")"\nif [ -s "$here/arm" ]; then\n  case " $* " in\n    *"$(cat "$here/arm")"*) if [ -e "$here/slow" ]; then exec sleep 9; fi; kill -KILL $$ ;;\n  esac\nfi\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
    const path = process.env.PATH
    process.env.PATH = `${fake}${delimiter}${path}`
    gitExe.cache.clear?.()
    const fresh = (name: string): string => {
      const dir = join(home, name)
      mkdirSync(dir)
      plain(['init', '-q'], dir)
      return dir
    }
    const arm = (words: string, slow = false): void => {
      writeFileSync(join(fake, 'arm'), words)
      if (slow) writeFileSync(join(fake, 'slow'), '1')
      else rmSync(join(fake, 'slow'), { force: true })
    }
    const went = (run: () => string[]): string => {
      try { return `went on: ${run().join(' ')}` } catch (error) { return `REFUSED: ${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      check('the rig holds: the product runs the stand-in git', gitExe() === join(fake, 'git'), `${gitExe()} | the stand-in git was not first on PATH, so gitExe in src/platform/git/gitExe.ts resolved another git or a stale cache`)
      arm('rev-parse --show-toplevel')
      const deadLayout = went(() => gitArgs(['add', 'x'], fresh('dead-layout')))
      check('a layout read that ends without an exit status does not stop a git add: its arguments are built with no filter settings, as on 1.0.11', deadLayout.startsWith('went on: ') && deadLayout.endsWith(' add x') && !deadLayout.includes('filter.'), `${deadLayout} | ${spawnHint}; a layout read with no exit status must fall back to no filter settings`)
      const deadMessages = went(() => gitFilterSkipMessages(fresh('dead-messages')))
      check('…and the stage detail carries no sentence about filters it could not check', deadMessages === 'went on: ', `${deadMessages} | gitFilterSkipMessages in src/platform/git/spawnArgs.ts must return no messages when its git read ends without an exit status`)
      const deadAsync = await gitArgsAsync(['checkout', 'x'], fresh('dead-async')).then(words => `went on: ${words.join(' ')}`, (error: unknown) => `REFUSED: ${error instanceof Error ? error.message : String(error)}`)
      check('…the same on the async road (git checkout)', deadAsync.startsWith('went on: ') && deadAsync.endsWith(' checkout x'), `${deadAsync} | ${spawnHint}; gitArgsAsync must fall back the same way as gitArgs`)
      arm('config --get-regexp')
      const deadFilters = went(() => gitArgs(['stash'], fresh('dead-filters')))
      check('a filter-settings read that ends without an exit status does not stop a git stash', deadFilters.startsWith('went on: ') && deadFilters.endsWith(' stash'), `${deadFilters} | ${spawnHint}; the filter-settings read must not throw when git ends without an exit status`)
      arm('config --show-scope')
      const deadScoped = went(() => gitArgs(['fetch', 'origin'], fresh('dead-scoped')))
      check('a config read that ends without an exit status does not stop a git fetch', deadScoped.startsWith('went on: ') && deadScoped.endsWith(' fetch origin'), `${deadScoped} | ${spawnHint}; the scoped config read must not throw when git ends without an exit status`)
      arm('rev-parse --show-toplevel', true)
      const startedAt = Date.now()
      const slowLayout = went(() => gitArgs(['add', 'x'], fresh('slow-layout')))
      check('a layout read with no answer within its 5 s limit does not stop a git add: a machine under load is not refused for being slow', slowLayout.startsWith('went on: ') && slowLayout.endsWith(' add x') && Date.now() - startedAt >= 4_000, `${slowLayout} after ${Date.now() - startedAt} ms | ${spawnHint}; the layout read must wait out its 5 s limit and then go on`)
      arm('')
      const answered = went(() => gitArgs(['add', 'x'], fresh('answered')))
      check('control: with git answering, the same call builds the same arguments', answered === deadLayout, `${answered} ≠ ${deadLayout} | ${spawnHint}; the fallback arguments must equal the arguments built when git answers`)
    } finally {
      process.env.PATH = path
      gitExe.cache.clear?.()
    }
  }
} finally {
  credentialServer.close()
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

console.log(failures === 0 ? 'GIT SPAWN SETTINGS: ALL GREEN' : `GIT SPAWN SETTINGS: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
