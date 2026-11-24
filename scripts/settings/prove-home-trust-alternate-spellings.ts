#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')

function runIn(
  configDir: string,
  body: string,
  opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): Record<string, unknown> {
  const src = `
    process.env.MERCURY_CONFIG_DIR = ${JSON.stringify(configDir)}
    delete process.env.MERCURY_HOME
    delete process.env.NODE_ENV
    delete process.env.CI
    const g = await import(${JSON.stringify(join(SRC, 'platform/config/globalConfig.ts'))})
    const trust = await import(${JSON.stringify(join(SRC, 'platform/config/trust.ts'))})
    const proj = await import(${JSON.stringify(join(SRC, 'platform/config/projectConfig.ts'))})
    g.enableConfigs()
    ${body}
  `
  const res = spawnSync(BUN, ['-e', src], {
    encoding: 'utf8',
    timeout: 60_000,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
  })
  if (res.error) return { childFailed: `spawn error: ${res.error.message}` }
  if (res.signal) return { childFailed: `killed by ${res.signal}` }
  if (res.status !== 0) return { childFailed: `exit ${res.status}`, stderr: (res.stderr ?? '').slice(-400) }
  const line = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? '{}'
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return { parseError: line, stderr: res.stderr }
  }
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-home-trust-o09-')))
try {
  console.log('\nO-09 Path A: trusting home via alternate case spelling or symlink must not trust child repositories')
  {
    const configDir = join(scratch, 'cfg-a')
    const fakeHome = join(scratch, 'TestHome')
    const untrustedRepo = join(fakeHome, 'untrusted-repo')
    const homeLink = join(scratch, 'home-link')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(untrustedRepo, { recursive: true })
    symlinkSync(fakeHome, homeLink)

    const env = { HOME: fakeHome, USERPROFILE: fakeHome, MERCURY_CREDENTIAL_STORE: 'file' }

    const linkGrant = runIn(configDir, `
      trust.setPathTrusted(${JSON.stringify(homeLink)})
      console.log(JSON.stringify({ ok: true }))
    `, { cwd: homeLink, env })
    check('setup: setPathTrusted on symlink to home succeeded', linkGrant.childFailed === undefined && linkGrant.ok === true, JSON.stringify(linkGrant))

    const childViaLink = runIn(configDir, `
      const target = ${JSON.stringify(join(homeLink, 'untrusted-repo'))}
      console.log(JSON.stringify({
        direct: trust.isPathTrusted(target),
        accepted: trust.checkHasTrustDialogAccepted(),
        homeByLink: trust.isPathTrusted(${JSON.stringify(homeLink)}),
        homeByName: trust.isPathTrusted(${JSON.stringify(fakeHome)}),
        underProjects: Object.keys(g.getGlobalConfig().projects ?? {}).length,
      }))
    `, { cwd: join(homeLink, 'untrusted-repo'), env })
    check(
      'the home itself reads trusted by the link and by its own name, and no project record was written for it',
      childViaLink.homeByLink === true && childViaLink.homeByName === true && childViaLink.underProjects === 0,
      JSON.stringify(childViaLink),
    )
    check(
      'Path A (symlink): child repo under symlink-to-home still reads NOT trusted',
      childViaLink.childFailed === undefined && childViaLink.direct === false && childViaLink.accepted === false,
      JSON.stringify(childViaLink),
    )

    if (process.platform === 'darwin' || process.platform === 'win32') {
      const cfgCase = join(scratch, 'cfg-case')
      mkdirSync(cfgCase, { recursive: true })
      const lowerHome = join(scratch, 'testhome')
      const lowerChild = join(lowerHome, 'untrusted-repo')
      const caseGrant = runIn(cfgCase, `
        trust.setPathTrusted(${JSON.stringify(lowerHome)})
        console.log(JSON.stringify({ ok: true }))
      `, { cwd: lowerHome, env })
      check('setup: setPathTrusted on alternate-case home spelling succeeded', caseGrant.childFailed === undefined && caseGrant.ok === true, JSON.stringify(caseGrant))

      const childViaCase = runIn(cfgCase, `
        console.log(JSON.stringify({
          direct: trust.isPathTrusted(${JSON.stringify(lowerChild)}),
          accepted: trust.checkHasTrustDialogAccepted(),
        }))
      `, { cwd: lowerChild, env })
      check(
        'Path A (case spelling): child repo under alternate-case home still reads NOT trusted',
        childViaCase.childFailed === undefined && childViaCase.direct === false && childViaCase.accepted === false,
        JSON.stringify(childViaCase),
      )
    }
  }

} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\nprove-home-trust-alternate-spellings: ${failures === 0 ? 'ALL HOLD' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
export {}
