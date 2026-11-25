#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond || !detail ? '' : ` — ${detail}; the step is held in runWorktreePrepareCommand (src/platform/git/worktree/worktree.ts) through holdStepForTrust and run by runStepsHeldForTrust (src/boot/process-state/processState.ts), which src/boot/setupScreens.tsx calls once the trust card is answered yes`}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-worktree-o02-')))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }

function world(tag: string): { configDir: string; repo: string; sentinel: string } {
  const configDir = join(scratch, tag, 'config')
  const repo = join(scratch, tag, 'repo')
  const sentinel = join(scratch, tag, 'prepare-ran.sentinel')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(repo, '.mercury'), { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: repo, env: gitEnv })
  writeFileSync(join(repo, 'README.md'), 'hello\n')
  writeFileSync(join(repo, '.mercury', 'settings.json'), `${JSON.stringify({ workspace: { worktree: { prepare: `printf ran >> ${JSON.stringify(sentinel)}` } } }, null, 2)}\n`)
  execFileSync('git', ['add', 'README.md', '.mercury/settings.json'], { cwd: repo, env: gitEnv })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo, env: gitEnv })
  return { configDir, repo, sentinel }
}

function start(at: { configDir: string; repo: string; sentinel: string }, before: string, after: string): Record<string, unknown> {
  const script = `
    globalThis.MACRO = { VERSION: '1.0.0' }
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(at.configDir)}
    process.env.MERCURY_CREDENTIAL_STORE = 'file'
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const { existsSync, readFileSync } = await import('node:fs')
    const g = await import(${JSON.stringify(join(SRC, 'platform/config/globalConfig.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'platform/config/trust.ts'))})
    const ps = await import(${JSON.stringify(join(SRC, 'boot/process-state/processState.ts'))})
    const { sessionSetup } = await import(${JSON.stringify(join(SRC, 'boot/sessionSetup.ts'))})
    g.enableConfigs()
    ps.setIsInteractive(true)
    ps.setOriginalCwd(${JSON.stringify(at.repo)})
    ps.setCwdState(${JSON.stringify(at.repo)})
    const ran = () => (existsSync(${JSON.stringify(at.sentinel)}) ? readFileSync(${JSON.stringify(at.sentinel)}, 'utf8') : '')
    ${before}
    const trustedBefore = trust.checkHasTrustDialogAccepted()
    await sessionSetup(${JSON.stringify(at.repo)}, 'default', false, true, 'o02-wt', false)
    const afterSetup = ran()
    ${after}
    console.log(JSON.stringify({ trustedBefore, afterSetup, atEnd: ran() }))
  `
  const res = spawnSync(BUN, ['-e', script], { cwd: at.repo, encoding: 'utf8', timeout: 60_000, env: { ...process.env, MERCURY_CONFIG_DIR: at.configDir, MERCURY_CREDENTIAL_STORE: 'file' } })
  const lastLine = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '{}'
  try {
    return { ...(JSON.parse(lastLine) as Record<string, unknown>), rc: res.status }
  } catch (error) {
    return { rc: res.status, unread: lastLine, why: String(error), stderr: (res.stderr ?? '').slice(-400) }
  }
}

try {
  console.log('\nA: a folder never trusted, and the start ends before any yes (the trust card answered no ends the process)')
  {
    const at = world('no')
    const seen = start(at, '', '')
    check('the start went through its setup in a folder that is not trusted', seen.rc === 0 && seen.trustedBefore === false, JSON.stringify(seen))
    check('workspace.worktree.prepare did not run before the trust card', seen.afterSetup === '' && !existsSync(at.sentinel), JSON.stringify(seen))
  }

  console.log('\nB: the same start, then the trust card answered yes')
  {
    const at = world('yes')
    const seen = start(at, '', 'ps.setSessionTrustAccepted(true)\n    await ps.runStepsHeldForTrust()\n    await ps.runStepsHeldForTrust()')
    check('the step was held through the setup', seen.rc === 0 && seen.trustedBefore === false && seen.afterSetup === '', JSON.stringify(seen))
    check('the held step ran once the yes was given, and ran once', seen.atEnd === 'ran' && readFileSync(at.sentinel, 'utf8') === 'ran', JSON.stringify(seen))
  }

  console.log('\nC: a folder its user has trusted before')
  {
    const at = world('trusted')
    const seen = start(at, `trust.setPathTrusted(${JSON.stringify(at.repo)})`, '')
    check('the step runs during the setup, as it always did', seen.rc === 0 && seen.trustedBefore === true && seen.afterSetup === 'ran' && seen.atEnd === 'ran', JSON.stringify(seen))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-worktree-prepare-waits-for-trust: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
