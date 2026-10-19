#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'refs-home-'))

const { appendObservation } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { collectMemoryRefs, renderMemoryRefLine } = await import('../../src/mneme/memoryRefs.ts')
const { lookupTokens } = await import('../../src/mneme/mnemeLookup.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const memoryDir = mkdtempSync(join(tmpdir(), 'refs-mem-'))
const libDir = join(memoryDir, 'library')
const projectRoot = mkdtempSync(join(tmpdir(), 'refs-proj-'))
mkdirSync(join(projectRoot, 'src'), { recursive: true })
writeFileSync(join(projectRoot, 'src', 'exists.ts'), 'export {}\n')

appendObservation({ text: 'release cadence is every second Thursday', source: 'operator', topicHint: 'releases' }, libDir)
appendObservation({ text: 'deploy rides src/exists.ts', source: 'operator', topicHint: 'deploy' }, libDir)
appendObservation({ text: 'release logic lives in src/deleted-file.ts', source: 'operator', topicHint: 'releases' }, libDir)
maybeConsolidate({ force: true, dir: libDir })
appendObservation({ text: 'release hotfix window opens Fridays', source: 'operator', topicHint: 'releases' }, libDir)

section('§1 deterministic selection, bounds, explainability')
{
  const refs = collectMemoryRefs('when is the release shipped', { libraryDir: libDir, projectRoot })
  check('topic ref ranks first (exact tier)', refs[0]?.kind === 'mneme-topic' && refs[0].refId === 'mneme-topic:releases', JSON.stringify(refs[0]))
  check('consolidated fact ref present with seq id', refs.some(r => r.kind === 'mneme-fact' && /^mneme:\d+$/.test(r.refId)))
  check('pending fact labeled unconsolidated', refs.some(r => r.kind === 'mneme-pending' && r.status === 'unconsolidated'))
  check('every ref carries a why-line and a Recall deref', refs.every(r => r.why.length > 0 && r.deref.startsWith('Recall ')))
  check('bounded ≤8', refs.length <= 8, String(refs.length))
  const twice = collectMemoryRefs('when is the release shipped', { libraryDir: libDir, projectRoot })
  check('selection is deterministic (stable across calls)', JSON.stringify(refs) === JSON.stringify(twice))
}

section('§2 freshness: a cited path that moved demotes to needs-review')
{
  const refs = collectMemoryRefs('release logic deploy', { libraryDir: libDir, projectRoot, maxRefs: 16 })
  const stale = refs.find(r => r.kind === 'mneme-fact' && r.summary.includes('deleted-file'))
  const fresh = refs.find(r => r.kind === 'mneme-fact' && r.summary.includes('exists.ts'))
  check('missing-path ref → needs-review', stale?.status === 'needs-review', JSON.stringify(stale))
  check('present-path ref → current', fresh?.status === 'current', JSON.stringify(fresh))
  check('needs-review ranks below current at equal tier', !stale || !fresh || refs.indexOf(fresh) !== -1 && refs.indexOf(fresh) < refs.indexOf(stale))
  const line = renderMemoryRefLine(stale!)
  check('render names the demotion', /needs review/.test(line), line)
}

section('§3 scope + the memory switch')
{
  const refsOtherQuery = collectMemoryRefs('bloom filter internals', { libraryDir: libDir, projectRoot })
  check('irrelevant query → zero refs', refsOtherQuery.length === 0, JSON.stringify(refsOtherQuery))
  process.env.MERCURY_BARE = '1'
  const refsOff = collectMemoryRefs('when is the release shipped', { libraryDir: libDir, projectRoot })
  check('memory off → zero refs', refsOff.length === 0)
  delete process.env.MERCURY_BARE
  const tokens = lookupTokens(`a a the the Release release ship ship 2026 ${Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')}`)
  check(
    'query tokens: lowercased, 3+ chars, no filler words, no bare numbers, deduped, at most 16',
    tokens.length === 16 && tokens[0] === 'release' && tokens[1] === 'ship' && !tokens.includes('the') && !tokens.includes('2026'),
    JSON.stringify(tokens),
  )
}

section('§4 filler words select nothing; a real word still finds its topic and its lines')
{
  const noiseLib = join(mkdtempSync(join(tmpdir(), 'refs-noise-')), 'library')
  appendObservation({ text: 'handover notes ride the command line', source: 'operator', topicHint: 'handover' }, noiseLib)
  appendObservation({ text: 'whether to show wanted rows was answered yourself', source: 'operator', topicHint: 'whether' }, noiseLib)
  maybeConsolidate({ force: true, dir: noiseLib })
  appendObservation({ text: 'command handover wanted whether show', source: 'operator', topicHint: 'handover' }, noiseLib)
  const refsOf = (query: string) => collectMemoryRefs(query, { libraryDir: noiseLib, projectRoot, maxRefs: 16 })
  const control = refsOf('handover')
  check('a real word finds its topic', control.some(r => r.refId === 'mneme-topic:handover' && r.why === "topic matches 'handover'"), JSON.stringify(control))
  check('a real word finds its content line', control.some(r => r.kind === 'mneme-fact' && r.why === "content matches 'handover'"), JSON.stringify(control))
  check('a real word finds its recent unconsolidated row', control.some(r => r.kind === 'mneme-pending' && r.why === "recent unconsolidated matches 'handover'"), JSON.stringify(control))
  const filler = refsOf('and the want how')
  check("filler words 'and the want how' select nothing", filler.length === 0, filler.map(r => r.why).join(' | '))
  const pronouns = refsOf('you were')
  check("filler words 'you were' select nothing", pronouns.length === 0, pronouns.map(r => r.why).join(' | '))
  const inside = refsOf('dove ether man')
  check('a token inside a longer word selects nothing', inside.length === 0, inside.map(r => r.why).join(' | '))
  const mixed = refsOf('and the want how handover')
  check('filler words beside a real word add nothing', JSON.stringify(mixed) === JSON.stringify(control), mixed.map(r => r.why).join(' | '))
  const command = refsOf('the command and')
  check('every why-line names the real word', command.length > 0 && command.every(r => r.why.endsWith("'command'")), command.map(r => r.why).join(' | '))
}

if (failures) {
  console.log(`\n❌ ${failures} memory-ref check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL MEMORY-REF PROOFS PASS')
