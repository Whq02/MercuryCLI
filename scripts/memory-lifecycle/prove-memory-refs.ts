#!/usr/bin/env bun
// prove-memory-refs — the ONE composition layer projects
// discriminated, bounded, explainable REFS over the stores (never bodies);
// deterministic ranking (exact > content > lesson > file); candidate status
// labeled; file-level freshness demotes to needs-review; OFF lanes vanish.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_MNEME = '1'

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch config home BEFORE the src module graph loads: the capsule leg's
// auto-mem store (getAutoMemPath) derives from the config home — an ambient
// home would accumulate observations across runs (solo-green, suite-red)
// and write into the REAL store.
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'refs-home-'))

const { appendObservation } = await import('../../src/memdir/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/memdir/mnemeConsolidate.ts')
const { collectMemoryRefs, queryTokens, renderMemoryRefLine } = await import('../../src/memdir/memoryRefs.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const memDir = mkdtempSync(join(tmpdir(), 'refs-mem-'))
const libDir = join(memDir, 'library')
const projectRoot = mkdtempSync(join(tmpdir(), 'refs-proj-'))
mkdirSync(join(projectRoot, 'src'), { recursive: true })
writeFileSync(join(projectRoot, 'src', 'exists.ts'), 'export {}\n')

// Seed MNEME: consolidated + pending
appendObservation({ text: 'release cadence is every second Thursday', source: 'operator', topicHint: 'releases' }, libDir)
maybeConsolidate({ force: true, dir: libDir })
appendObservation({ text: 'release hotfix window opens Fridays', source: 'operator', topicHint: 'releases' }, libDir)
// Seed a candidate card, an approved card, a memory file, a stale-path file
writeFileSync(join(memDir, 'card-observed-ready.md'), '---\nname: observed-ready\ndescription: prefer observed-ready waits for release verification\nmetadata:\n  type: experience-card\napproved: false\n---\nbody')
writeFileSync(join(memDir, 'card-rg-fixed.md'), '---\nname: rg-fixed\ndescription: use rg -F for literal release-tag searches\nmetadata:\n  type: experience-card\napproved: true\n---\nbody')
writeFileSync(join(memDir, 'project-deploy.md'), '---\nname: project-deploy\ndescription: deploy rides src/exists.ts\ntype: project\n---\nbody')
writeFileSync(join(memDir, 'stale-anchor.md'), '---\nname: stale-anchor\ndescription: release logic lives in src/deleted-file.ts\ntype: project\n---\nbody')
writeFileSync(join(memDir, 'MEMORY.md'), '# index\n')
writeFileSync(join(memDir, 'card-x.superseded.20260101.abc.md'), '---\nname: superseded-release-card\ndescription: release stuff\n---\n')

section('§1 deterministic selection, bounds, explainability')
{
  const refs = collectMemoryRefs('when is the release shipped', { memoryDir: memDir, libraryDir: libDir, projectRoot })
  check('topic ref ranks first (exact tier)', refs[0]?.kind === 'mneme-topic' && refs[0].refId === 'mneme-topic:releases', JSON.stringify(refs[0]))
  check('consolidated fact ref present with seq id', refs.some(r => r.kind === 'mneme-fact' && /^mneme:\d+$/.test(r.refId)))
  check('pending fact labeled unconsolidated', refs.some(r => r.kind === 'mneme-pending' && r.status === 'unconsolidated'))
  check('candidate card labeled candidate', refs.some(r => r.refId === 'card:card-observed-ready.md' && r.status === 'candidate'))
  check('every ref carries a why-line', refs.every(r => r.why.length > 0))
  check('superseded audit copies excluded', !refs.some(r => r.refId.includes('.superseded.')))
  check('bounded ≤8', refs.length <= 8, String(refs.length))
  const line = renderMemoryRefLine(refs.find(r => r.status === 'candidate')!)
  check('candidate render says UNVERIFIED', /CANDIDATE — unverified/.test(line), line)
  const twice = collectMemoryRefs('when is the release shipped', { memoryDir: memDir, libraryDir: libDir, projectRoot })
  check('selection is deterministic (stable across calls)', JSON.stringify(refs) === JSON.stringify(twice))
}

section('§2 freshness: a cited path that moved demotes to needs-review')
{
  // maxRefs widened: tier-4 file refs compete with the §1 corpus and the
  // default top-8 would slice them off before the freshness assertions.
  const refs = collectMemoryRefs('release logic deploy', { memoryDir: memDir, libraryDir: libDir, projectRoot, maxRefs: 16 })
  const stale = refs.find(r => r.refId === 'memfile:stale-anchor.md')
  const fresh = refs.find(r => r.refId === 'memfile:project-deploy.md')
  check('missing-path ref → needs-review', stale?.status === 'needs-review', JSON.stringify(stale))
  check('present-path ref → current', fresh?.status === 'current', JSON.stringify(fresh))
  check('needs-review ranks below current at equal tier', !stale || !fresh || refs.indexOf(fresh) !== -1 && refs.indexOf(fresh) < refs.indexOf(stale))
  const line = renderMemoryRefLine(stale!)
  check('render names the demotion', /needs review/.test(line), line)
}

section('§3 scope + OFF lanes')
{
  const refsOtherQuery = collectMemoryRefs('bloom filter internals', { memoryDir: memDir, libraryDir: libDir, projectRoot })
  check('irrelevant query → zero refs', refsOtherQuery.length === 0, JSON.stringify(refsOtherQuery))
  delete process.env.MERCURY_MNEME
  const refsOff = collectMemoryRefs('when is the release shipped', { memoryDir: memDir, libraryDir: libDir, projectRoot })
  check('MNEME OFF → no mneme refs, cards/files remain', refsOff.every(r => r.store !== 'mneme') && refsOff.length > 0)
  process.env.MERCURY_MNEME = '1'
  check('queryTokens bounded + deduped', queryTokens('a a the the release release ship ship').length <= 12)
}

section('§4 capsule integration: refs ride the working set, digest-joined')
{
  // Hermetic memory base: getMemoryBaseDir() is the resolved config home,
  // which this proof scratch-pins; a tmp git workspace feeds the snapshot.
  const { execFileSync } = await import('node:child_process')
  const base = mkdtempSync(join(tmpdir(), 'refs-membase-'))
  const ws = mkdtempSync(join(tmpdir(), 'refs-ws-'))
  writeFileSync(join(ws, 'main.ts'), 'export const releaseGate = 1\n')
  const git = (...a: string[]): void => {
    execFileSync('git', ['-C', ws, '-c', 'user.email=memory@bench', '-c', 'user.name=memory-bench', ...a], { stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('commit', '-q', '-m', 'baseline')
  const { getAutoMemPath } = await import('../../src/memdir/paths.ts')
  const capMemDir = getAutoMemPath()
  mkdirSync(capMemDir, { recursive: true })
  const capLib = join(capMemDir, 'library')
  appendObservation({ text: 'release gate opens after the smoke suite', source: 'operator', topicHint: 'releases' }, capLib)
  maybeConsolidate({ force: true, dir: capLib })
  const { assembleContextCapsule, renderCapsule } = await import('../../src/services/projectIntel/capsule.ts')
  const cap1 = assembleContextCapsule({ workspace: ws, task: 'harden the release gate in main.ts' })
  check('capsule assembled', cap1 !== null)
  check('memory refs ride the capsule', (cap1?.memoryRefs?.length ?? 0) > 0, JSON.stringify(cap1?.memoryRefs))
  check('refs are refs — no bodies (summary-bounded)', (cap1?.memoryRefs ?? []).every(r => r.summary.length <= 140))
  const rendered = renderCapsule(cap1!)
  check('render carries the labeled memory section', /Memory \(task-scoped refs/.test(rendered) && /dereference before relying/.test(rendered), rendered.split('\n').slice(-3).join(' | '))
  // Digest membership: a memory-only change must change the identity.
  const corr = correctFactLocal(capLib)
  check('correction applied for the digest probe', corr)
  const cap2 = assembleContextCapsule({ workspace: ws, task: 'harden the release gate in main.ts' })
  check('memory-only change changes the capsule digest (dedup honesty)', cap1 !== null && cap2 !== null && cap1.digest !== cap2.digest, `${cap1?.digest} vs ${cap2?.digest}`)
  const capIrr = assembleContextCapsule({ workspace: ws, task: 'explain bloom filters' })
  check('irrelevant task → no memory refs in the capsule', (capIrr?.memoryRefs?.length ?? 0) === 0, JSON.stringify(capIrr?.memoryRefs))
}

function correctFactLocal(lib: string): boolean {
  const { listTopicDocs } = require('../../src/memdir/mnemeConsolidate.ts') as typeof import('../../src/memdir/mnemeConsolidate.ts')
  const { correctFact } = require('../../src/memdir/mnemeCorrect.ts') as typeof import('../../src/memdir/mnemeCorrect.ts')
  const doc = listTopicDocs(lib).find(d => d.slug === 'releases')
  const seq = doc?.sections[0]?.entries[0]?.seq
  if (!seq) return false
  return correctFact({ targetSeq: seq, text: 'release gate opens after smoke AND soak suites', source: 'operator', dir: lib }).ok
}

if (failures) {
  console.log(`\n❌ ${failures} memory-ref check(s) failed`)
  process.exit(1)
}
console.log('\n✅ ALL MEMORY-REF PROOFS PASS')
