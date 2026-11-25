#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

const SWITCH = 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC'
const OWN_MACHINE = 'http://127.0.0.1:18431'
const SAVED_REMOTE = 'http://models.example.invalid:9931'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const on = (): void => { process.env[SWITCH] = '1' }
const off = (): void => { delete process.env[SWITCH] }
const settle = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'automatic-requests-')))
const home = join(scratch, 'home')
const bin = join(scratch, 'bin')
const repo = join(scratch, 'on-feature')
for (const dir of [home, bin, repo]) mkdirSync(dir)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
off()

try {
  const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
  enableConfigs()

  section('§1 the pull-request badge: gh is asked without the switch and not with it')
  if (process.platform === 'win32') {
    console.log('  the stand-in gh is a shell script, which this platform does not run; nothing proven in this section')
  } else {
    writeFileSync(join(bin, 'gh'), ['#!/bin/sh', 'here=$(dirname "$0")', 'printf \'%s\\n\' "$*" >> "$here/calls.log"', 'printf \'%s\' \'{"number":7,"url":"https://example.invalid/acme/widgets/pull/7","headRefName":"feature","state":"OPEN","isDraft":false}\'', ''].join('\n'))
    chmodSync(join(bin, 'gh'), 0o755)
    const git = (...args: string[]): void => {
      const run = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })
      if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
    }
    git('init', '-q', '-b', 'main')
    git('commit', '-q', '--allow-empty', '-m', 'first')
    git('checkout', '-q', '-b', 'feature')
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`
    process.chdir(repo)
    const { fetchPrStatus } = await import('../../src/platform/git/ghPrStatus.ts')
    const calls = (): string[] => (existsSync(join(bin, 'calls.log')) ? readFileSync(join(bin, 'calls.log'), 'utf8').split('\n').filter(line => line !== '') : [])
    const where = 'fetchPrStatus in src/platform/git/ghPrStatus.ts asks isEssentialTrafficOnly before it runs gh'
    on()
    const dark = await fetchPrStatus()
    check('with the switch the badge has no answer', dark === null, `got ${JSON.stringify(dark)}; ${where}`)
    check('with the switch gh is not run', calls().length === 0, `gh was run: ${JSON.stringify(calls())}; ${where}`)
    off()
    const lit = await fetchPrStatus()
    check('without the switch gh is asked once for the pull request', calls().length === 1 && calls()[0]!.startsWith('pr view --json '), `gh calls: ${JSON.stringify(calls())}`)
    check('without the switch the badge shows the pull request', lit?.number === 7, `got ${JSON.stringify(lit)}`)
  }

  section('§2 a saved remote model server: asked by itself without the switch; with it, only when the user asks')
  {
    const { refreshLocalDiscovery, __resetLocalDiscoveryForTest } = await import('../../src/models/roads/local/localDiscovery.ts')
    const env = { MERCURY_LOCAL_PROBE_TARGETS: `openai-compatible=${OWN_MACHINE}`, MERCURY_LOCAL_BASE_URL: SAVED_REMOTE }
    const asked = async (...reads: Array<{ force?: boolean }>): Promise<{ own: number; remote: number }> => {
      __resetLocalDiscoveryForTest()
      const urls: string[] = []
      const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
        urls.push(String(input instanceof Request ? input.url : input))
        await settle(20)
        return new Response('{}', { status: 404 })
      }) as typeof fetch
      await Promise.all(reads.map(opts => refreshLocalDiscovery({ env, fetchImpl, ...opts })))
      return { own: urls.filter(url => url.startsWith(OWN_MACHINE)).length, remote: urls.filter(url => url.startsWith(SAVED_REMOTE)).length }
    }
    const where = 'refreshLocalDiscovery in src/models/roads/local/localDiscovery.ts keeps an unforced read to loopback targets when isEssentialTrafficOnly'
    off()
    const lit = await asked({})
    check('without the switch a read made by itself asks the saved remote server', lit.remote > 0 && lit.own > 0, JSON.stringify(lit))
    on()
    const dark = await asked({})
    check('with the switch a read made by itself does not ask the saved remote server', dark.remote === 0, `${JSON.stringify(dark)}; ${where}`)
    check('with the switch a read made by itself still asks the server on this machine', dark.own > 0, `${JSON.stringify(dark)}; ${where}`)
    const forced = await asked({ force: true })
    check('with the switch a read the user asked for (the picker, a model on that server) asks the saved remote server', forced.remote > 0 && forced.own > 0, `${JSON.stringify(forced)}; ${where}`)
    const overlapped = await asked({}, { force: true })
    check('with the switch a read the user asked for is not answered by one made by itself that was already under way', overlapped.remote > 0, `${JSON.stringify(overlapped)}; ${where}`)
    off()
    const joined = await asked({}, { force: true })
    check('without the switch two reads at once still share one round', joined.remote === lit.remote && joined.own === lit.own, `${JSON.stringify(joined)} against ${JSON.stringify(lit)}`)
  }
} finally {
  process.chdir(tmpdir())
  removeScratch(scratch)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} automatic requests and the switch: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
