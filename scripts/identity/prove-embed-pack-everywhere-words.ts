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

console.log('\n§1 every page says the pack rides every release archive')
{
  const readme = read('README.md')
  const install = read('docs/INSTALL.md')
  const mneme = read('docs/MNEME.md')
  const windows = read('docs/INSTALL-WINDOWS-FROM-SOURCE.md')
  const compat = read('docs/COMPATIBILITY.md')
  check('INSTALL.md: Build from source says every release archive carries the pack built for its platform', /Every release archive carries the embedding pack built for its\s+platform/.test(install))
  check('README: What is inside says the model is bundled in every release archive, built for its platform', /bundled in every release archive,\s+built for its platform/.test(readme))
  check('INSTALL.md: the source-build words name setup, build-embed.ts and the --default model fetch, and word match only without cargo', install.includes('`setup` also builds the local embedding addon') && install.includes('bun run scripts/vendor/build-embed.ts') && install.includes('bun run scripts/vendor/fetch-embed-models.ts --default') && /without cargo the\s+pack is skipped, setup says so, and Mneme memory lookup runs word match only/.test(install))
  check('MNEME.md: the model arrives with every release archive, built for its platform', /arrives with\s+every release archive, built for its platform/.test(mneme) && mneme.includes('fetch-embed-models.ts --default'))
  check('the Windows source page: a release archive carries the engine, the pack and the model; --default named', /archive always carries the engine, the embedding pack and the model/.test(windows) && windows.includes('fetch-embed-models.ts --default'))
  check('COMPATIBILITY.md: every archive bundles the addon built for its platform and the model', /Every archive\s+also bundles the `vendor\/embed` addon built for its platform and the 118 MB\s+`bge-base-en-v1\.5` embedding model/.test(compat))
}

console.log('\n§2 the pages say what Linux and Windows run: a vectorised kernel, about a tenth of a second per Recall by meaning')
{
  const RETIRED = [/plain maths loop/, /second and a half/, /faster kernel/]
  for (const page of ['docs/INSTALL.md', 'docs/MNEME.md', 'docs/INSTALL-WINDOWS-FROM-SOURCE.md', 'docs/COMPATIBILITY.md']) {
    const text = read(page)
    check(`${page}: a vectorised kernel, about a tenth of a second per Recall by meaning`, /vectorised (maths )?kernel/.test(text) && /about a\s+tenth of\s+a\s+second/.test(text))
    const stale = RETIRED.filter(shape => shape.test(text)).map(String)
    check(`${page}: the plain-loop words of the earlier release are gone`, stale.length === 0, stale.join(' · '))
  }
  const install = read('docs/INSTALL.md')
  check('INSTALL.md: Build from source ties the kernel to Linux and Windows and names the macOS road beside it', /on Linux and Windows the maths runs a\s+vectorised kernel/.test(install) && /few hundredths on macOS, which uses Accelerate/.test(install))
}

console.log('\n§3 no page says the pack is the Apple silicon archive\'s alone')
{
  const pages = docPages()
  const offenders: string[] = []
  for (const page of pages) {
    for (const hit of macOnlyHits(read(page))) offenders.push(`${page} ${hit}`)
  }
  check(`the README and ${pages.length - 1} docs pages carry no macOS-only pack claim`, offenders.length === 0, offenders.slice(0, 6).join(' · '))
  check('the health row names no platform for the embedder', !/darwin|macOS|Apple silicon|Windows|Linux/.test(read('src/utils/healthReport.ts').split("id: 'memory-embedder'")[1]?.split("id: 'context'")[0] ?? 'Windows'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`❌ embed pack everywhere words: ${failures} FAILED`)
  process.exit(1)
}
console.log('✅ embed pack everywhere words: clean')
