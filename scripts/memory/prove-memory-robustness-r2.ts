#!/usr/bin/env bun
// prove-memory-robustness-r2.ts — locks the round-2 memory-management robustness
// fixes (found by a 5-agent adversarially-verified hunt). Behavioral where the
// module is bun-run loadable, source-grep regression guards otherwise.
//   Run:  ~/.bun/bin/bun run scripts/memory/prove-memory-robustness-r2.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) fail++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const sec = (t: string) => console.log('\n' + t)
const root = join(import.meta.dir, '..', '..')
const src = (p: string) => readFileSync(join(root, 'src', p), 'utf-8')

const { capIndexLine, MAX_INDEX_LINE_CHARS } = await import('../../src/memdir/experienceCards.js')
const { deriveSlug } = await import('../../src/commands/remember/remember.js')

// ── MED-1: slug disambiguator (data-loss) — distinct lessons → distinct slugs ──
sec('MED-1 slug collision: a content disambiguator distinguishes same-title lessons')
{
  const a = deriveSlug('Same Title', 'class-x\nlesson body A')
  const b = deriveSlug('Same Title', 'class-x\nlesson body B')
  const a2 = deriveSlug('Same Title', 'class-x\nlesson body A')
  check('distinct lessons (same title) ⇒ distinct slugs', a !== b, `${a} vs ${b}`)
  check('identical lesson ⇒ stable slug (intended supersede)', a === a2)
  const tool = src('tools/RememberLessonTool/RememberLessonTool.ts')
  check('RememberLessonTool passes problemClass+lesson as the disambiguator', /deriveSlug\(\s*input\.title \|\| input\.problemClass,\s*`\$\{input\.problemClass\}\\n\$\{input\.lesson\}`/.test(tool))
}

// ── MED-2: stale cards dropped from recall (mirror superseded + promote gate) ──
sec('MED-2 stale recall: the scan drops both superseded AND stale')
{
  const scan = src('memdir/memoryScan.ts')
  check("memoryScan drops freshness==='stale' too (not just superseded)", /card\?\.freshness === 'superseded' \|\| card\?\.freshness === 'stale'/.test(scan))
}

// ── MED-3 + LOW-7: atomic card-body write + tmp cleanup on failure ──
sec('MED-3/LOW-7 atomic writes: card body / superseded / promoted / index via atomicWriteFile')
{
  const ec = src('memdir/experienceCards.ts')
  check('atomicWriteFile helper exists (delegates to the durable primitive)', /async function atomicWriteFile/.test(ec) && /await durableAtomicPublish\(path, content\)/.test(ec))
  // The canonical writes route through atomicWriteFile with the (pure)
  // lineage-edge stamp wrapping the content arg — the atomicity invariant is
  // the call, not the exact content expression.
  check('card body write is atomic', /await atomicWriteFile\(\s*cardPath,\s*supersededPath\s*\?\s*stampLineageEdge\(built\.markdown,[\s\S]{0,120}:\s*built\.markdown,?\s*\)/.test(ec))
  check('promoted card write is atomic', /await atomicWriteFile\(\s*cardPath,\s*supersededPath\s*\?\s*stampLineageEdge\(promoted,[\s\S]{0,120}:\s*promoted,?\s*\)/.test(ec))
  check('superseded copy write is atomic', /await atomicWriteFile\(\s*path,\s*stampLineageEdge\(markSuperseded\(priorMarkdown\)/.test(ec))
  check('index write is atomic (applyIndexUpdate)', /await atomicWriteFile\(indexPath, updated\)/.test(ec))
  check('no remaining non-atomic writeFile(cardPath, …)', !/await writeFile\(cardPath,/.test(ec))
}

// ── LOW-4: index-pointer match is link-anchored ](filename), not bare (filename) ──
sec('LOW-4 index match: link-anchored ](filename) (no sibling false-match)')
{
  const ec = src('memdir/experienceCards.ts')
  check('experienceCards refresh matches ](filename)', /includes\(`\]\(\$\{filename\}\)`\)/.test(ec))
  check('no bare (filename) substring match remains', !/includes\(`\(\$\{filename\}\)`\)/.test(ec))
}

// ── LOW-6: capIndexLine is surrogate-safe (no lone surrogate written) ──
sec('LOW-6 capIndexLine surrogate-safe: a boundary emoji never leaves a lone surrogate')
{
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  // place an emoji so its surrogate pair straddles the MAX-1 cut boundary
  const line = 'x'.repeat(MAX_INDEX_LINE_CHARS - 2) + '😀' + 'tail'.repeat(20)
  const capped = capIndexLine(line)
  check('clamped to <= MAX', capped.length <= MAX_INDEX_LINE_CHARS, `len=${capped.length}`)
  check('no lone surrogate in the clamped line', !lone.test(capped))
  check('still ends with the ellipsis', capped.endsWith('…'))
}

// ── R3 correction: manifest filename emitted RAW (the round-2 sanitize was a
//    regression — NFKC broke the validFilenames round-trip for legit non-ASCII
//    names on macOS NFD, silently dropping them from recall; reverted). ──
sec('R3 correction: manifest filename is RAW (sanitizing it regressed non-ASCII recall)')
{
  const scan = src('memdir/memoryScan.ts')
  check('formatMemoryManifest does NOT safeSanitizeField the filename', !/safeSanitizeField\(m\.filename\)/.test(scan))
  check('formatMemoryManifest emits the filename raw (round-trips with validFilenames)', /\$\{memory\.filename\} \(\$\{new Date\(memory\.mtimeMs\)\.toISOString\(\)\}\)/.test(scan))
}

// ── R3: the SECOND index-pointer match (pointerToken) is link-anchored too ──
sec('R3 LOW-4 completion: writeExperienceCard pointerToken is link-anchored')
{
  const ec = src('memdir/experienceCards.ts')
  check('pointerToken is ](built.filename), not bare (built.filename)', /pointerToken = `\]\(\$\{built\.filename\}\)`/.test(ec) && !/pointerToken = `\(\$\{built\.filename\}\)`/.test(ec))
}

// ── R3 MED-2: per-card flock around the supersede + canonical write ──
sec('R3 MED-2: writeExperienceCard locks the card path (no lost-update race)')
{
  const ec = src('memdir/experienceCards.ts')
  check('locks cardPath (lockfile.lock(cardPath, { lockfilePath: `${cardPath}.lock` … }))', /lockfile\.lock\(cardPath,\s*\{[\s\S]{0,80}lockfilePath: `\$\{cardPath\}\.lock`/.test(ec))
  check('the card lock is released in a finally (fail-open)', /finally\s*\{[\s\S]{0,60}if \(cardRelease\) await cardRelease\(\)/.test(ec))
  // Ordering proves the write is INSIDE the lock: acquire → write → release.
  const lockIdx = ec.indexOf('lockfile.lock(cardPath')
  // Anchor on the lineage-stamped canonical write (inside the same call).
  const writeIdx = ec.indexOf("stampLineageEdge(built.markdown, 'supersedes'")
  const relIdx = ec.indexOf('if (cardRelease) await cardRelease()')
  check('canonical write is between lock-acquire and lock-release', lockIdx > 0 && writeIdx > lockIdx && relIdx > writeIdx, `lock=${lockIdx} write=${writeIdx} rel=${relIdx}`)
}

// ── R4: BOTH supersede+write sites under the per-card flock (race fix complete) ──
sec('R4: promote path also locked (both card-write sites mutually exclude)')
{
  const ec = src('memdir/experienceCards.ts')
  check('withCardLock helper exists (shared per-card flock on ${cardPath}.lock)', /async function withCardLock/.test(ec) && /lockfile\.lock\(cardPath,\s*\{[\s\S]{0,80}lockfilePath: `\$\{cardPath\}\.lock`/.test(ec))
  check('promoteExperienceCard wraps its read-modify-write in withCardLock', /const locked = await withCardLock\(\s*cardPath,/.test(ec))
  // Ordering: withCardLock(...) returns (lock released) → 'early' check → index update.
  const wcl = ec.indexOf('const locked = await withCardLock')
  const early = ec.indexOf("if ('early' in locked) return locked.early", wcl)
  const idxUpd = ec.indexOf('serializeIndexUpdate(indexPath', early)
  check('promote closure (under lock) ends BEFORE the index update (no nesting/deadlock)', wcl > 0 && early > wcl && idxUpd > early, `wcl=${wcl} early=${early} idx=${idxUpd}`)
}

console.log(fail === 0 ? '\n✅ memory-robustness round-2 fixes hold' : `\n❌ ${fail} check(s) FAILED`)
process.exit(fail === 0 ? 0 : 1)
