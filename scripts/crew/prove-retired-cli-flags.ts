#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, NODE, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const tally = makeTally('prove-retired-cli-flags')
const root = mkdtempSync(join(tmpdir(), 'retired-cli-flags-'))
const retired = ['--t', 'eam-name'].join('')
const expected = 'Unknown skill: nosuchcommandxyz'
let run = 0

function launch(flag: string, format: string | null, inline: boolean) {
  const home = join(root, String(++run))
  const cwd = join(home, 'cwd')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  const env = { ...childEnv(home, 1), HOME: home, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }
  const result = spawnSync(NODE, [DIST, '-p', '/nosuchcommandxyz', '--agent-id', 'x@y', '--agent-name', 'x', ...(inline ? [`${flag}=y`] : [flag, 'y']), ...(format === null ? [] : ['--output-format', format])], {
    cwd, env, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let words = (result.stdout ?? '').trim()
  if (format !== null) {
    try {
      const frame = words.split('\n').map(line => JSON.parse(line)).find(frame => frame.type === 'result' && frame.is_error === false)
      words = typeof frame?.result === 'string' ? frame.result : ''
    } catch {
      words = ''
    }
  }
  return { code: result.status, words, stderr: result.stderr ?? '', error: result.error?.message }
}

try {
  for (const format of [null, 'json', 'stream-json']) {
    const label = format ?? 'text'
    const current = launch('--crew-name', format, false)
    console.log(`${label} current: ${JSON.stringify(current)}`)
    tally.check(`${label}: the current flag exits zero`, current.code === 0, JSON.stringify(current))
    tally.check(`${label}: the current flag reaches the unknown skill`, current.words === expected, current.words)
    for (const inline of [false, true]) {
      const old = launch(retired, format, inline)
      console.log(`${label} retired ${inline ? 'equals' : 'separate'}: ${JSON.stringify(old)}`)
      tally.check(`${label}, ${inline ? 'equals' : 'separate'}: the retired flag exits zero like the current flag`, old.code === 0 && old.code === current.code, JSON.stringify(old))
      tally.check(`${label}, ${inline ? 'equals' : 'separate'}: no option refusal`, !old.stderr.includes('unknown option'), old.stderr)
      tally.check(`${label}, ${inline ? 'equals' : 'separate'}: both spellings answer the same skill words`, old.words === expected && old.words === current.words, JSON.stringify({ current: current.words, retired: old.words }))
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
