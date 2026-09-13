#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = join(import.meta.dir, '..', '..')
const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title)
}
function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* sourceFiles(path)
    else if (/\.tsx?$/.test(entry)) yield path
  }
}
function offenders(dir: string, pattern: RegExp, except: string[] = []): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(dir)) {
    const rel = file.slice(ROOT.length + 1)
    if (except.includes(rel)) continue
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${rel}:${index + 1}`)
    })
  }
  return hits
}
const daemonDir = join(ROOT, 'src', 'daemon')
const srcDir = join(ROOT, 'src')
const RELEASE_NOTES = ['src/constants/changelog.ts']

section('§1 no resident-size sweep under src/daemon')
check('the sweep module is gone', !existsSync(join(ROOT, 'src/daemon/rssWatchdog.ts')))
const residentReads = offenders(daemonDir, /\brss\b|RssSweep|RssWatchdog|RssBreach|RssReading/i)
check('no file under src/daemon reads a resident size or names a sweep of one', residentReads.length === 0, residentReads.join(' · '))

section('§2 no memory-limit flag in the registry')
check('MERCURY_CHILD_RSS_LIMIT_MB is not a row', !FLAG_REGISTRY.some(flag => flag.env === 'MERCURY_CHILD_RSS_LIMIT_MB'))
const memoryRows = FLAG_REGISTRY.filter(flag => /RSS|MEMORY_LIMIT|MEM_LIMIT/.test(flag.env) || /memory limit|memory guard|resident set/i.test(`${flag.summary} ${flag.off}`))
check('no row names a memory limit, a memory guard or a resident set', memoryRows.length === 0, memoryRows.map(flag => flag.env).join(', '))
const limitReads = offenders(srcDir, /CHILD_RSS_LIMIT|RSS_LIMIT_MB/)
check('nothing under src reads a memory-limit switch', limitReads.length === 0, limitReads.join(' · '))

section('§3 no memory verdict on the session facts')
const facts = readFileSync(join(ROOT, 'src/services/engine-connector/seatProjections.ts'), 'utf8')
check('the facts carry no memoryGuard field and no box-facts type of their own', !facts.includes('memoryGuard') && !facts.includes('BoxFactsV1'))
const guardPainters = offenders(srcDir, /memoryGuard|memory guard/, RELEASE_NOTES)
check('nothing under src paints a memory guard (the Bash tool, the health resource, the seat)', guardPainters.length === 0, guardPainters.join(' · '))

section('§4 no memory outcome in the spawn ledger')
const ledgerOutcomes = offenders(srcDir, /rss-limit/)
check("no 'rss-limit' outcome is written anywhere under src", ledgerOutcomes.length === 0, ledgerOutcomes.join(' · '))
check('the ledger module names no resident size', !/\brss\b/i.test(readFileSync(join(ROOT, 'src/utils/spawnLedger.ts'), 'utf8')))

section("§5 the daemon's park reasons carry no memory reason")
const memoryParks = offenders(daemonDir, /daemon: memory|memory limit|memoryParkReason|over the memory/)
check('no park reason or park requester under src/daemon names memory', memoryParks.length === 0, memoryParks.join(' · '))
const main = readFileSync(join(ROOT, 'src/daemon/main.ts'), 'utf8')
check('the idle edge completes a requested park through the one door, with no memory branch before it', main.includes('if (completeRequestedPark(short, roster)) {') && !main.includes('retireRequestedPark'))
check('the daemon arms no sweep at boot', !/arm\w*Rss|Watchdog\(/.test(main))

section('§6 the durability page says so')
const durability = readFileSync(join(ROOT, 'docs/DURABILITY.md'), 'utf8')
check('the page carries the one sentence and names no memory limit', durability.includes('Mercury never stops or parks a runner for its memory use.') && !/RSS_LIMIT|memory guard|child memory/i.test(durability))

console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
