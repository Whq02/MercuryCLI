#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jest, mock, spyOn } from 'bun:test'
import { SCENARIOS } from './chatScenarios.ts'

const table = join(import.meta.dir, 'recording-draws.tsv')
const only = (key: string): string | undefined => {
  const index = process.argv.indexOf(key)
  return index < 0 ? undefined : process.argv[index + 1]
}

async function chatFrames(name: string): Promise<number> {
  process.env.NODE_ENV = 'development'
  const scenario = SCENARIOS.find(row => row.name === name)
  assert.ok(scenario, `no chat recording named ${name}`)
  const { default: instances } = await import('../../src/screen/renderer/instances.js')
  const { openStage, closeStage } = await import('./chatScenarios.ts')
  const harness = { ...(await import('../lib/settingsPopupHarness.ts')) }
  const scheduler = require('scheduler/unstable_mock') as { unstable_flushAllWithoutAsserting(): void; unstable_advanceTime(ms: number): void }
  mock.module('scheduler', () => scheduler)
  const immediate = setImmediate
  const pending: Array<Promise<() => void>> = []
  const yieldTurn = async (): Promise<void> => {
    scheduler.unstable_flushAllWithoutAsserting()
    await new Promise<void>(resolve => immediate(resolve))
    while (pending.length > 0) {
      for (const publish of await Promise.all(pending.splice(0))) publish()
      await Promise.resolve()
    }
    scheduler.unstable_flushAllWithoutAsserting()
  }
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-01-02T03:04:05.000Z'))
  mock.module('../lib/settingsPopupHarness.ts', () => ({
    ...harness,
    settle: async (ms: number): Promise<void> => {
      for (let left = ms; left > 0; left -= 4) {
        await yieldTurn()
        const step = Math.min(4, left)
        scheduler.unstable_advanceTime(step)
        jest.advanceTimersByTime(step)
      }
      await yieldTurn()
    },
  }))
  let frames = 0
  const register = instances.set.bind(instances)
  const tap = spyOn(instances, 'set').mockImplementation((stream, ink) => {
    const tracked = <A extends unknown[], T>(run: (...args: A) => Promise<T>) => (...args: A): Promise<T> => new Promise((resolve, reject) => {
      pending.push(run(...args).then(value => () => resolve(value), error => () => reject(error)))
    })
    const history = { ...require('../../src/sessions/transcripts/sessionStorage.js') as typeof import('../../src/sessions/transcripts/sessionStorage.js') }
    const instructions = { ...require('../../src/sessions/instructions/instructionFiles.js') as typeof import('../../src/sessions/instructions/instructionFiles.js') }
    const cockpit = { ...require('../../src/screen/cockpit-gauges/index.js') as typeof import('../../src/screen/cockpit-gauges/index.js') }
    const memory = { ...require('../../src/sessions/mneme/entryKnapsack.js') as typeof import('../../src/sessions/mneme/entryKnapsack.js') }
    mock.module('../../src/sessions/transcripts/sessionStorage.js', () => ({ ...history, listSessionsAcrossProjects: tracked(history.listSessionsAcrossProjects) }))
    mock.module('../../src/sessions/instructions/instructionFiles.js', () => ({ ...instructions, getInstructionFiles: tracked(instructions.getInstructionFiles) }))
    mock.module('../../src/screen/cockpit-gauges/index.js', () => ({ ...cockpit, gitSnapshot: tracked(cockpit.gitSnapshot), traceSnapshot: tracked(cockpit.traceSnapshot) }))
    mock.module('../../src/sessions/mneme/entryKnapsack.js', () => ({ ...memory, composeMemoryAtStart: tracked(memory.composeMemoryAtStart) }))
    ink.subscribeFrame(() => { frames++ })
    return register(stream, ink)
  })
  try {
    const stage = await openStage(scenario.name, scenario.options)
    try {
      await scenario.run(stage)
      assert.ok(stage.steps.length > 0 && frames > 0, `${name}: no recorded point or completed Ink frame`)
      return frames
    } finally {
      await closeStage(stage)
    }
  } finally {
    tap.mockRestore()
    jest.useRealTimers()
  }
}

async function layoutPasses(): Promise<Map<string, number>> {
  const scratch = mkdtempSync(join(tmpdir(), 'recording-layout-draws-'))
  try {
    const trace = join(scratch, 'trace.jsonl')
    process.env.INK_YOGA_TRACE = trace
    const { createLayoutNode } = await import('../../src/screen/renderer/layout/engine.js')
    const { getCellLayoutCounters } = await import('../../src/screen/renderer/layout/cellLayout.js')
    const { recordCorpus, replayScreens } = await import('../ink-runtime/layoutRecordingScenes.js')
    const engine = { create: createLayoutNode, counters: getCellLayoutCounters, trace, open: null }
    const screens = readFileSync(join(import.meta.dir, '../ink-runtime/recordings/layout-node-scenes.jsonl'), 'utf8')
    const out = new Map<string, number>()
    for (const [name, lines] of [...recordCorpus(engine), ...replayScreens(engine, screens)]) {
      const sealed = /^sealed: (\d+) layouts\b/.exec(lines[0] ?? '')
      const passes = sealed ? Number(sealed[1]) : lines.filter(line => line.startsWith('layout ')).length
      assert.ok(!out.has(name), `duplicate layout scene ${name}`)
      out.set(name, passes)
    }
    return out
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const one = only('--chat')
if (one !== undefined) {
  console.log(`frames\t${await chatFrames(one)}`)
  process.exit(0)
}

const rows = new Map<string, number>()
for (const { name } of SCENARIOS) {
  const child = spawnSync(process.execPath, [import.meta.path, '--chat', name], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(child.status, 0, `${name}: ${child.error ?? child.signal ?? child.stderr}`)
  const count = /^frames\t(\d+)$/m.exec(child.stdout)
  assert.ok(count, `${name}: no completed-frame reading from the chat stage`)
  rows.set(`chat\t${name}`, Number(count[1]))
}
for (const [name, count] of await layoutPasses()) rows.set(`layout\t${name}`, count)

if (process.argv.includes('--sample')) {
  process.stdout.write([...rows].map(([key, count]) => `${key}\t${count}\n`).join(''))
  process.exit(0)
}

function readCounts(path: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const line of readFileSync(path, 'utf8').trimEnd().split(/\r?\n/)) {
    const match = /^((?:chat|layout)\t[^\t]+)\t(\d+)(?:\tunsteady: (\d+) to (\d+) in 10 runs)?$/.exec(line)
    assert.ok(match, `invalid draw reading in ${path}: ${line}`)
    const [, key, high, low, top] = match
    assert.ok(low === undefined || (Number(low) < Number(high) && top === high), `invalid range for ${key} in ${path}`)
    assert.ok(!counts.has(key!), `duplicate draw reading for ${key} in ${path}`)
    counts.set(key!, Number(high))
  }
  assert.deepEqual([...counts.keys()], [...rows.keys()], `${path} does not match the recording scenes`)
  return counts
}

const writing = process.argv.includes('--write')
assert.ok(writing || existsSync(table), `missing ${table}: save ten --sample runs as 01.tsv through 10.tsv, then --write <directory>`)
const previous = existsSync(table) ? readCounts(table) : null
const directory = only('--write')
assert.ok(!writing || directory, 'use --write <directory> with ten independent --sample readings named 01.tsv through 10.tsv')
const samples = directory ? Array.from({ length: 10 }, (_, i) => readCounts(join(directory, `${String(i + 1).padStart(2, '0')}.tsv`))) : []
const next: string[] = []
for (const [key, actual] of rows) {
  const before = previous?.get(key)
  const counts = samples.map(sample => sample.get(key)!)
  const high = writing ? Math.max(...counts) : before!
  assert.ok(before === undefined || high <= before, `${key}: cannot raise the ceiling from ${before} to ${high}; inspect the extra draw`)
  assert.ok(actual <= high, `${key}: ${actual} draws, ceiling ${high}; inspect the extra draw before changing the table`)
  if (writing) {
    const low = Math.min(...counts)
    next.push(`${key}\t${high}${low === high ? '' : `\tunsteady: ${low} to ${high} in 10 runs`}\n`)
  }
}
if (writing) writeFileSync(table, next.join(''))
for (const [kind, unit] of [['chat', 'Ink frames'], ['layout', 'layout passes']] as const) {
  const counts = [...rows].filter(([key]) => key.startsWith(`${kind}\t`))
  console.log(`${counts.length} ${kind} scenes, ${counts.reduce((n, [, count]) => n + count, 0)} ${unit}`)
}
