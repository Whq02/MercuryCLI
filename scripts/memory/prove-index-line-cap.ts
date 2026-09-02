#!/usr/bin/env bun
// prove-index-line-cap.ts — guards the auto-written MEMORY.md index-line length cap
// (experienceCards.ts capIndexLine / MAX_INDEX_LINE_CHARS). MEMORY.md is embedded
// VERBATIM into the cached memory prefix (memdir.ts MAX_ENTRYPOINT_BYTES=25_000);
// an uncapped card `summary` would creep that cached prefix toward its byte cap
// (past which the oldest entries get silently dropped). The cap bounds the SYSTEM's
// contribution so auto-card-writes can't worsen the cliff. Runs against the REAL
// buildExperienceCard. Run: ~/.bun/bin/bun run scripts/memory/prove-index-line-cap.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }

const { buildExperienceCard, capIndexLine, MAX_INDEX_LINE_CHARS } = await import(
  '../../src/memdir/experienceCards.js'
)

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

console.log('── MEMORY.md index-line length cap (cached-prefix bounded growth) ──')

// (a) capIndexLine directly
{
  const short = '- [t](f.md) — experience-card (approved): tiny hook'
  check('short line is unchanged', capIndexLine(short) === short)
  const long = '- [t](f.md) — experience-card (approved): ' + 'x'.repeat(500)
  const capped = capIndexLine(long)
  check('long line is clamped to <= MAX_INDEX_LINE_CHARS', capped.length <= MAX_INDEX_LINE_CHARS, `len=${capped.length}`)
  check('clamped line ends with the ellipsis', capped.endsWith('…'))
  check('MAX_INDEX_LINE_CHARS is the documented ~200 budget', MAX_INDEX_LINE_CHARS === 200)
}

// (b) buildExperienceCard caps its emitted indexLine (the real write path)
{
  const longSummary = 'this summary is way too long for one index line — ' + 'detail '.repeat(60)
  const built = buildExperienceCard({
    name: 'cap-test', title: 'Cap test', summary: longSummary,
    problemClass: 'memory-efficiency', lesson: 'a'.repeat(80),
    sourceRefs: ['commit:abc'], confidence: 'likely', freshness: 'fresh',
    approved: true, createdAt: '2026-06-24T00:00:00.000Z', greenGate: true,
  })
  check('build ok', built.ok === true)
  check('emitted indexLine is clamped (<= MAX)', !!built.indexLine && built.indexLine.length <= MAX_INDEX_LINE_CHARS, `len=${built.indexLine?.length}`)
  check('clamped indexLine ellipsized', !!built.indexLine && built.indexLine.endsWith('…'))

  const shortBuilt = buildExperienceCard({
    name: 'cap-test2', title: 'Short', summary: 'a concise one-line hook',
    problemClass: 'memory-efficiency', lesson: 'a'.repeat(80),
    sourceRefs: ['commit:abc'], confidence: 'likely', freshness: 'fresh',
    approved: false, createdAt: '2026-06-24T00:00:00.000Z', greenGate: true,
  })
  check('a concise summary is preserved verbatim (no clamp, no ellipsis)', !!shortBuilt.indexLine && shortBuilt.indexLine.includes('a concise one-line hook') && !shortBuilt.indexLine.endsWith('…'))
}

// (c) wiring: buildExperienceCard routes its index line through capIndexLine
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = readFileSync(join(import.meta.dir, '..', '..', 'src', 'memdir', 'experienceCards.ts'), 'utf-8')
  check('buildExperienceCard wraps the index line in capIndexLine', /const indexLine = capIndexLine\(/.test(src))
}

console.log(fail === 0 ? '✅ index-line cap holds' : `❌ ${fail} check(s) FAILED`)
process.exit(fail === 0 ? 0 : 1)
