#!/usr/bin/env bun
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const MAC_ONLY_SHAPES: Array<[string, RegExp]> = [
  ['the Apple silicon archive alone includes the pack', /macOS Apple silicon (release )?archive includes the embedding/i],
  ['bundled in the Apple silicon archive alone', /bundled in the macOS Apple silicon/i],
  ['arrives with the Apple silicon archive alone', /arrives with the\s+macOS Apple silicon/i],
  ['one archive alone bundles the embed addon', /`macos-arm64` archive also bundles the `vendor\/embed`/i],
  ['other platforms run word match only', /other platforms run word match only/i],
]

function macOnlyHits(text: string): string[] {
  const firstLine = new Map<string, number>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const window = `${lines[i]} ${lines[i + 1] ?? ''}`
    for (const [label, shape] of MAC_ONLY_SHAPES) {
      if (shape.test(window) && !firstLine.has(label)) firstLine.set(label, i + 1)
    }
  }
  return [...firstLine].map(([label, line]) => `line ${line}: ${label}`)
}

function docPages(): string[] {
  const out: string[] = ['README.md']
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = relative(ROOT, full)
      if (rel.startsWith(join('docs', 'releases'))) continue
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith('.md')) out.push(rel)
    }
  }
  walk(join(ROOT, 'docs'))
  return out
}

console.log('============================================================')
console.log(' the memory embedding pack ships in every archive: the words')
console.log('============================================================')

console.log('\n§0 self-test: the shapes trip on the old words and stay silent on the new')
{
  const old = 'the model (bge-base, bundled in the macOS Apple silicon release\narchive; other platforms run word match only in this release)'
  const fresh = 'bundled in every release archive, built for its platform'
  check('the old README shape trips twice (bundled in the Apple silicon archive alone, other platforms word match only)', macOnlyHits(old).length === 2, macOnlyHits(old).join(' · '))
  check('the old MNEME shape trips across a line break', macOnlyHits('that arrives with the\nmacOS Apple silicon release archive').length === 1)
  check('the new words stay silent', macOnlyHits(fresh).length === 0, macOnlyHits(fresh).join(' · '))
}

console.log('\n§1 the plain-loop words of the earlier release are gone')
{
  const RETIRED = [/plain maths loop/, /second and a half/, /faster kernel/]
  for (const page of ['docs/INSTALL.md', 'docs/MNEME.md', 'docs/INSTALL-WINDOWS-FROM-SOURCE.md', 'docs/COMPATIBILITY.md']) {
    const text = read(page)
    const stale = RETIRED.filter(shape => shape.test(text)).map(String)
    check(`${page}: the plain-loop words of the earlier release are gone`, stale.length === 0, stale.join(' · '))
  }
}

console.log('\n§2 no page says the pack is the Apple silicon archive\'s alone')
{
  const pages = docPages()
  const offenders: string[] = []
  for (const page of pages) {
    for (const hit of macOnlyHits(read(page))) offenders.push(`${page} ${hit}`)
  }
  check(`the README and ${pages.length - 1} docs pages carry no macOS-only pack claim`, offenders.length === 0, offenders.slice(0, 6).join(' · '))
  const globals = globalThis as Record<string, unknown>
  if (globals.MACRO === undefined) globals.MACRO = { VERSION: '1.0.0' }
  ;(await import('../../src/platform/settings/config.ts')).enableConfigs()
  const embedderSays = await (await import('../../src/platform/health/sections/memory.ts')).memoryChecks().find(row => row.id === 'memory-embedder')?.run()
  const embedModels = await import('../../src/sessions/mneme/embedModels.ts')
  const readiness = embedModels.describeSemanticReadiness()
  const ownersWords = [...(readiness.state === 'ok' ? [readiness.model, String(readiness.dimension)] : [readiness.words, readiness.note]), embedModels.memoryRecallModeWords()].filter(words => words.length > 0).sort((a, b) => b.length - a.length)
  const rowsOwnWords = ownersWords.reduce((text, words) => text.split(words).join('…'), `${embedderSays?.evidence ?? ''} ${embedderSays?.fix ?? ''}`)
  check('the health row names no platform for the embedder', embedderSays !== undefined && /present: |degraded: /.test(embedderSays.evidence) && !/darwin|macOS|Apple silicon|Windows|Linux/.test(rowsOwnWords), rowsOwnWords)
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ embed pack everywhere words: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ embed pack everywhere words: clean')
