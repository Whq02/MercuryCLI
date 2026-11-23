#!/usr/bin/env bun
// gate-watch: src/commands/verbs/mcp.tsx src/integrations/mcp/serverConfigs.ts src/platform/config/trust.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.MERCURY_PROOF_DIST ?? join(ROOT, 'dist', 'mercury.mjs')
const NODE = process.env.MERCURY_NODE ?? 'node'
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-get-trust-')))
const SENTENCE = 'mcp: this folder is not trusted, so its project MCP server adder was not loaded from .mercury/mcp.json — start Mercury here once and accept the trust card, and it connects'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function home(trustedFolders: string[]): string {
  const dir = mkdtempSync(join(SCRATCH, 'home-'))
  writeFileSync(
    join(dir, '.mercury.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '99.0.0',
      numStartups: 10,
      theme: 'dark',
      mcpServers: { userly: { type: 'stdio', command: process.execPath, args: ['-e', 'process.exit(0)'] } },
      projects: Object.fromEntries(trustedFolders.map(folder => [folder, { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }])),
    }),
  )
  return dir
}

function project(name: string): { dir: string; sentinel: string } {
  const dir = realpathSync(mkdtempSync(join(SCRATCH, `${name}-`)))
  const sentinel = join(dir, 'server-started.txt')
  mkdirSync(join(dir, '.mercury'), { recursive: true })
  writeFileSync(
    join(dir, '.mercury', 'mcp.json'),
    JSON.stringify({
      mcpServers: {
        adder: { type: 'stdio', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'started')`] },
      },
    }),
  )
  return { dir, sentinel }
}

function mcp(configDir: string, cwd: string, ...args: string[]): { rc: number | null; out: string } {
  const result = spawnSync(NODE, [DIST, 'mcp', ...args], {
    cwd,
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: configDir,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_MCP_TIMEOUT_MS: '3000',
      BROWSER: '/usr/bin/true',
    },
    encoding: 'utf8',
    timeout: 120_000,
  })
  return { rc: result.status, out: `${result.stdout}${result.stderr}` }
}

if (!existsSync(DIST)) {
  console.log(`no bundle at ${DIST} — build first; this proof drives the artifact`)
  process.exit(1)
}

console.log('============================================================')
console.log(' mcp get obeys workspace trust: an untrusted project server is named, never started')
console.log('============================================================')

try {
  console.log('\n§1 untrusted folder: `mcp get adder` says the trust reason and starts nothing')
  {
    const untrusted = project('untrusted')
    const got = mcp(home([]), untrusted.dir, 'get', 'adder')
    console.log(`  rc=${got.rc} · ${JSON.stringify(got.out.trim().split('\n').slice(0, 3))}`)
    check('exit 0', got.rc === 0, `${got.rc} — the mcp get handler in src/commands/verbs/mcp.tsx must exit 0 for an untrusted project server; output: ${got.out.slice(0, 300)}`)
    check('the singular sentence names the server and the remedy', got.out.includes(SENTENCE), `${got.out.slice(0, 400)} — mcp get in src/commands/verbs/mcp.tsx must print the untrusted-folder sentence built in src/integrations/mcp/serverConfigs.ts (line starting mcp: this folder is not trusted)`)
    check('no Status line — the server was not probed', !got.out.includes('Status:'), `${got.out.slice(0, 400)} — mcp get in src/commands/verbs/mcp.tsx must return before probing a project server from an untrusted folder`)
    check('the server command never ran (sentinel absent)', !existsSync(untrusted.sentinel), 'mcp get in src/commands/verbs/mcp.tsx must not spawn a project-scope server while the folder is untrusted')
    const listed = mcp(home([]), untrusted.dir, 'list')
    check('mcp list in the same folder says the counted reason and starts nothing either', listed.out.includes('its 1 project MCP server was not loaded') && !existsSync(untrusted.sentinel), `${listed.out.slice(0, 400)} — mcp list in src/commands/verbs/mcp.tsx must print the counted untrusted-folder sentence from src/integrations/mcp/serverConfigs.ts and start nothing`)
  }

  console.log('\n§2 the same folder, trusted and the server approved: `mcp get adder` probes it and prints Status')
  {
    const trusted = project('trusted')
    writeFileSync(join(trusted.dir, '.mercury', 'settings.local.json'), JSON.stringify({ kit: { projectOn: ['adder'] } }))
    const got = mcp(home([trusted.dir]), trusted.dir, 'get', 'adder')
    console.log(`  rc=${got.rc} · ${JSON.stringify(got.out.trim().split('\n').slice(0, 4))}`)
    check('exit 0', got.rc === 0, `${got.rc} — mcp get in src/commands/verbs/mcp.tsx must exit 0 for a trusted, approved project server; output: ${got.out.slice(0, 300)}`)
    check('Status is printed', /^\s+Status: /m.test(got.out), `${got.out.slice(0, 400)} — mcp get in src/commands/verbs/mcp.tsx must probe an approved server in a trusted folder and print a Status line`)
    check('Scope reads project', got.out.includes('Scope: project'), `${got.out.slice(0, 400)} — mcp get in src/commands/verbs/mcp.tsx must print Scope: project for a server from .mercury/mcp.json`)
    check('no trust sentence', !got.out.includes('this folder is not trusted'), `${got.out.slice(0, 400)} — the trust check (src/platform/config/trust.ts, used by src/integrations/mcp/serverConfigs.ts) must read this folder as trusted when its project entry has hasTrustDialogAccepted`)
    check('the probe started the server (sentinel present — the sentinel is live)', existsSync(trusted.sentinel), 'mcp get in src/commands/verbs/mcp.tsx must spawn the approved server (kit.projectOn in .mercury/settings.local.json) when probing')
  }

  console.log('\n§3 a user-scope server in an untrusted folder is unchanged')
  {
    const untrusted = project('untrusted-user')
    const got = mcp(home([]), untrusted.dir, 'get', 'userly')
    console.log(`  rc=${got.rc} · ${JSON.stringify(got.out.trim().split('\n').slice(0, 3))}`)
    check('exit 0', got.rc === 0, `${got.rc} — mcp get in src/commands/verbs/mcp.tsx must exit 0 for a user-scope server; output: ${got.out.slice(0, 300)}`)
    check('Status is printed for the user-scope server', /^\s+Status: /m.test(got.out) && got.out.includes('Scope: user'), `${got.out.slice(0, 400)} — workspace trust in src/integrations/mcp/serverConfigs.ts must gate only project-scope servers, not user-scope ones`)
    check('no trust sentence for a server outside the checkout', !got.out.includes('this folder is not trusted'), `${got.out.slice(0, 400)} — mcp get in src/commands/verbs/mcp.tsx must print the trust sentence only for a project-scope server`)
    check('the project server still never ran', !existsSync(untrusted.sentinel), 'a user-scope mcp get must not start the untrusted folder project server')
  }
} finally {
  rmSync(SCRATCH, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — prove-mcp-get-trust (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
