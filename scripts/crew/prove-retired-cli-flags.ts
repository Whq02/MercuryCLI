#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, NODE, childEnv, makeTally } from '../daemon/dupline-world.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { answerOf, frameLines, isCompleted } from '../lib/rows.ts'

const tally = makeTally('prove-retired-cli-flags')
const root = mkdtempSync(join(tmpdir(), 'retired-cli-flags-'))
const nonsense = '--frobnicate'
const former = [['--t', 'eam-name'].join(''), ['--crew', '-name'].join(''), ['--agent', '-name'].join(''), ['--agent', '-id'].join(''), ['--seat', '-id'].join(''), '--seat', '--crew', ['--seat', '-color'].join(''), '--parent', '--role']
let run = 0

function launch(flag: string, format: string | null, inline: boolean) {
  const home = join(root, String(++run))
  const cwd = join(home, 'cwd')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  const env = { ...childEnv(home, 1), HOME: home, ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key' }
  const result = spawnSync(NODE, [DIST, 'run', '/nosuchcommandxyz', ...(flag === '' ? [] : inline ? [`${flag}=y`] : [flag, 'y']), ...(format === null ? [] : ['--format', format])], {
    cwd, env, encoding: 'utf8', timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let words = (result.stdout ?? '').trim()
  if (format !== null) words = answerOf(frameLines(words).find(isCompleted))
  const stderr = result.stderr ?? ''
  return { code: result.status, words, stderr, firstLine: stderr.trim().split('\n')[0] ?? '', error: result.error?.message }
}

try {
  for (const format of [null, 'json', 'rows']) {
    const label = format ?? 'text'
    const bare = launch('', format, false)
    tally.check(`${label}: with no identity flag at all the run reaches the unknown skill`, bare.code === 0 && bare.words === 'Unknown skill: nosuchcommandxyz', JSON.stringify(bare))
    for (const inline of [false, true]) {
      const shape = inline ? 'equals' : 'separate'
      const control = launch(nonsense, format, inline)
      console.log(`${label} nonsense ${shape}: ${JSON.stringify(control)}`)
      tally.check(`${label}, ${shape}: nonsense is refused by the parser with its own exit code`, control.code === 2 && control.firstLine === `error: unknown option '${inline ? `${nonsense}=y` : nonsense}'`, JSON.stringify(control))
      for (const flag of former) {
        const old = launch(flag, format, inline)
        console.log(`${label} ${flag} ${shape}: ${JSON.stringify(old)}`)
        tally.check(`${label}, ${shape}: ${flag} exits exactly as nonsense does`, old.code === control.code, JSON.stringify(old))
        tally.check(`${label}, ${shape}: ${flag} draws the parser's own unknown-option line`, old.firstLine === control.firstLine.replace(nonsense, flag), JSON.stringify({ old: old.firstLine, control: control.firstLine }))
        tally.check(`${label}, ${shape}: ${flag} runs nothing`, old.words === '', old.words)
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
tally.finish()
