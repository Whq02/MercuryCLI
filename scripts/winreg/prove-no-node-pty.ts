#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'

const t = checker()

t.section('the root manifest stays node-pty-free')
{
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[field] ?? {}
    t.check(
      `${field} has no node-pty`,
      !Object.keys(deps).some(k => k === 'node-pty' || k.endsWith('/node-pty')),
      Object.keys(deps).filter(k => k.includes('pty')).join(', ') || 'clean',
    )
  }
  const lock = readFileSync('bun.lock', 'utf8')
  t.check(
    'the lockfile carries no node-pty resolution',
    !/"node-pty@/.test(lock),
    /"node-pty@/.test(lock) ? 'node-pty resolved in bun.lock' : 'clean',
  )
}

t.section('the dormant-tier probe seam still exists (the reason for the rule)')
{
  const src = readFileSync('src/daemon/runPtyHost.ts', 'utf8')
  t.check(
    'runPtyHost still probes for node-pty by capability',
    src.includes('node-pty'),
    'probe text present',
  )
}

t.finish('prove-no-node-pty')
