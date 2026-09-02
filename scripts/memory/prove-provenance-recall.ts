#!/usr/bin/env bun
// ============================================================================
//  scripts/memory/prove-provenance-recall.ts
//  PROOF (lane CP-B, operator-named priority): recall is provenance-honest —
//  a surfaced memory naming a file/flag that no longer exists SAYS SO, and
//  one whose referents check out stays clean. Driven through the real
//  surfacing reader (readMemoriesForSurfacing), not a re-implementation.
//
//    §1 extraction precision: real path/flag shapes extract; placeholders,
//       URLs, globs and bare words never do (a "missing" verdict can only
//       be a real absence)
//    §2 verification: dead paths and unregistered flags flag as missing;
//       live paths and registered flags pass; probe errors fail OPEN
//    §3 the surfacing pipeline carries the note INTO the content — and the
//       attachment header stays the frozen freshness contract (no referent
//       text there)
//    §4 age is not the mechanism: a FRESH memory with a dead referent still
//       gets the note (referent truth beats mtime)
//
//  Run:  ~/.bun/bin/bun run scripts/memory/prove-provenance-recall.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const watchdog = setTimeout(() => {
  console.log('FATAL: prover watchdog (120s) — treat as failure')
  process.exit(1)
}, 120_000)
watchdog.unref?.()
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const scratch = mkdtempSync(join(tmpdir(), 'mercury-provenance-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')

const { extractMemoryReferents, verifyMemoryReferents, referentNote } = await import(
  '../../src/memdir/memoryReferents.js'
)
const { readMemoriesForSurfacing, memoryHeader } = await import(
  '../../src/utils/attachments/memorySurfacing.js'
)

console.log('============================================================')
console.log(' provenance-stamped recall — driven proof')
console.log('============================================================')

section('§1 extraction precision — paths and flags in, noise out')
{
  const text = [
    'The gate lives in src/utils/permissions/capabilityGate.ts and reads MERCURY_AGENT_CAP.',
    'Template {file} and glob src/**/*.ts and url https://example.com/a.ts never count.',
    'Bare words like filename or dot.command stay out; ./scripts/run-all.sh counts.',
    'Env $HOME/x.ts is a template too.',
  ].join('\n')
  const refs = extractMemoryReferents(text)
  const tokens = refs.map(r => r.token)
  check('the real relative path extracts', tokens.includes('src/utils/permissions/capabilityGate.ts'), JSON.stringify(tokens))
  check('the dot-relative script extracts', tokens.includes('./scripts/run-all.sh'))
  check('the registry flag extracts', tokens.includes('MERCURY_AGENT_CAP'))
  check(
    'placeholders, globs, urls and bare words never extract',
    !tokens.some(t => t.includes('{') || t.includes('*') || t.includes('example.com') || t === 'dot.command' || t.includes('$')),
    JSON.stringify(tokens),
  )
}

section('§2 verification — dead flags/paths missing, live ones pass, probes fail open')
{
  const projectRoot = join(scratch, 'proj')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src/alive.ts'), 'export {}\n')
  const verdict = verifyMemoryReferents(
    'Live: src/alive.ts. Dead: src/gone.ts. Real flag MERCURY_MISSION. Fake flag MERCURY_NO_SUCH_FLAG_XYZ.',
    { projectRoot },
  )
  const missing = verdict.missing.map(m => m.token)
  check('the dead path is missing', missing.includes('src/gone.ts'), JSON.stringify(missing))
  check('the live path passes', !missing.includes('src/alive.ts'))
  check('the registered flag passes (real registry)', !missing.includes('MERCURY_MISSION'))
  check('the unregistered flag is missing', missing.includes('MERCURY_NO_SUCH_FLAG_XYZ'))
  const failOpen = verifyMemoryReferents('see src/thing.ts', {
    projectRoot,
    fileExists: () => {
      throw new Error('probe exploded')
    },
  })
  check('a throwing probe fails OPEN (nothing branded missing)', failOpen.missing.length === 0, JSON.stringify(failOpen.missing))
  check('the note is silence when nothing is missing', referentNote(failOpen) === '')
}

section('§3 the surfacing pipeline carries the note in the CONTENT; the header stays frozen')
{
  const memDir = join(scratch, 'memdir')
  mkdirSync(memDir, { recursive: true })
  const dead = join(memDir, 'dead-pointer.md')
  writeFileSync(
    dead,
    `---\nname: dead-pointer\ndescription: where the retry logic lives\ntype: project\n---\n\nThe backoff lives in ${join(scratch, 'no-such-dir')}/retry.ts under the flag MERCURY_NO_SUCH_FLAG_XYZ.\n`,
  )
  const clean = join(memDir, 'clean-note.md')
  writeFileSync(clean, `---\nname: clean-note\ndescription: a plain preference\ntype: user\n---\n\nPrefers terse summaries with no file claims.\n`)
  const surfaced = await readMemoriesForSurfacing([
    { path: dead, mtimeMs: Date.now() },
    { path: clean, mtimeMs: Date.now() },
  ])
  const deadRow = surfaced.find(m => m.path === dead)
  const cleanRow = surfaced.find(m => m.path === clean)
  check('both files surfaced', deadRow !== undefined && cleanRow !== undefined)
  const deadNote = (deadRow?.content ?? '').split('Referent check:')[1] ?? ''
  check(
    'the dead-referent memory carries the note, and the NOTE names the dead path',
    deadNote.includes('no-such-dir') && deadNote.includes('no longer exists at that path'),
    deadNote.slice(0, 200),
  )
  check('the note names the dead flag too', (deadRow?.content ?? '').includes('MERCURY_NO_SUCH_FLAG_XYZ'))
  check('the clean memory carries NO note', !(cleanRow?.content ?? '').includes('Referent check:'))
  check('the header stays the frozen freshness contract', !(deadRow?.header ?? '').includes('Referent'), deadRow?.header)
  check('the header still carries the freshness line', (deadRow?.header ?? '').startsWith('Memory (saved '), deadRow?.header)
  const headerNow = memoryHeader('/mem/x.md', Date.now() - 60_000)
  check('memoryHeader itself is untouched by the referent mechanism', !headerNow.includes('Referent'))
}

section('§4 referent truth beats mtime — a fresh memory with a dead pointer still notes')
{
  const memDir = join(scratch, 'memdir2')
  mkdirSync(memDir, { recursive: true })
  const fresh = join(memDir, 'fresh-dead.md')
  writeFileSync(
    fresh,
    `---\nname: fresh-dead\ndescription: written seconds ago\ntype: project\n---\n\nJust learned: config moved to ${join(scratch, 'vanished')}/config.yaml today.\n`,
  )
  const surfaced = await readMemoriesForSurfacing([{ path: fresh, mtimeMs: Date.now() }])
  check(
    'the note rides even at age zero (no staleness caveat needed)',
    (surfaced[0]?.content ?? '').includes('Referent check:'),
    (surfaced[0]?.content ?? '').slice(-160),
  )
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL PROVENANCE-RECALL PROOFS PASS' : `❌ ${failures} PROVENANCE-RECALL CHECK(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
