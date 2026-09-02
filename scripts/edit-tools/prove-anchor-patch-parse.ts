#!/usr/bin/env bun
// ============================================================================
//  scripts/edit-tools/prove-anchor-patch-parse.ts — grammar totality for the
//  anchored patch dialect (contract c.6.1).
//
//  Laws:
//    G. the canonical grammar parses — every op form, bodies, blank rows,
//       multi-section, same-path merge metadata
//    R. every rejection class yields ITS typed error code with the offending
//       line named — never a throw, never a guess
//    T. bounded tolerance repairs with warnings (fences, range spellings,
//       trailing space) and canonical input parses warning-free
//    D. unified-diff contamination gets the teaching error
//
//  Run:  ~/.bun/bin/bun run scripts/edit-tools/prove-anchor-patch-parse.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'anchor-patch-parse-'))
process.env.CLAUDE_CODE_SIMPLE = '1'

const { parseAnchorPatch, ANCHOR_PATCH_BOUNDS } = await import(
  '../../src/services/changeTransaction/anchorPatch.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const A = 'fa:0123456789ab'
const RA = 'ra:0123456789ab:L10+5'

type Err = { ok: false; code: string; line: number; message: string }
function expectError(label: string, patch: string, code: string, lineHint?: number): void {
  const r = parseAnchorPatch(patch)
  if (r.ok) {
    check(label, false, `parsed OK, expected [${code}]`)
    return
  }
  const e = r as Err
  const lineOk = lineHint === undefined || e.line === lineHint
  check(label, e.code === code && lineOk, `got [${e.code}] line ${e.line}: ${e.message.slice(0, 90)}`)
}

console.log('— G. the canonical grammar —')
{
  const patch = [
    `file /tmp/a.ts ${A}`,
    'replace 3-5',
    '| const x = 1',
    '|',
    '| const y = 2',
    'insert 10',
    '| // appended after 10',
    'prepend start',
    '| // file head',
    'delete 20-21',
    'cut 30-40 into helpers',
    `file /tmp/b.ts ${A}`,
    'paste helpers after 7',
    'insert end',
    '| // tail',
    `file /tmp/c.ts ${A}`,
    'move-to /tmp/d.ts',
  ].join('\n')
  const r = parseAnchorPatch(patch)
  check('canonical multi-section patch parses', r.ok, r.ok ? '' : (r as Err).message)
  if (r.ok) {
    check('three sections', r.sections.length === 3)
    check('zero warnings on canonical input', r.warnings.length === 0, JSON.stringify(r.warnings))
    const a = r.sections[0]!
    check('section ops in order', a.ops.map(o => o.kind).join(',') === 'replace,insert,prepend,delete,cut')
    const rep = a.ops[0]!
    check('replace body preserved (blank row included)', rep.kind === 'replace' && rep.body.join('\u0000') === 'const x = 1\u0000\u0000const y = 2')
    check('cut register recorded', r.cutRegisters.has('helpers'))
    check('paste of own cut is not a store read', !r.storeReads.has('helpers'))
    const c = r.sections[2]!
    check('move-to parsed', c.ops[0]!.kind === 'move-to')
  }
  const anonPatch = [`file /tmp/a.ts ${A}`, 'cut 1-2', 'paste after 5'].join('\n')
  const anon = parseAnchorPatch(anonPatch)
  check('anonymous cut + paste parses', anon.ok)
  const blocks = parseAnchorPatch(
    [`file /tmp/a.ts ${A}`, 'replace-block 12', '| body', 'insert-after-block 30', '| body'].join('\n'),
  )
  check('block ops parse', blocks.ok)
  const overPaste = parseAnchorPatch([`file /tmp/a.ts ${A}`, 'cut 1-2 into r1', 'paste r1 over 9-12'].join('\n'))
  check('paste over range parses', overPaste.ok)
  const raPatch = parseAnchorPatch([`file /tmp/a.ts ${RA}`, 'replace 11', '| x'].join('\n'))
  check('range anchors accepted in headers', raPatch.ok)
  const deleteFile = parseAnchorPatch([`file /tmp/a.ts ${A}`, 'delete-file'].join('\n'))
  check('delete-file as sole op parses', deleteFile.ok)
}

console.log('— R. the typed rejection vocabulary —')
{
  expectError('empty patch', '   \n  ', 'empty')
  expectError('content before any section', `replace 1-2\n| x`, 'no-section', 1)
  expectError('bad header (no anchor)', 'file /tmp/a.ts', 'bad-header', 1)
  expectError('bad header (bogus anchor)', 'file /tmp/a.ts fa:xyz', 'bad-header', 1)
  expectError('bad header (spaced path)', `file /tmp/my file.ts ${A}`, 'bad-header', 1)
  expectError('unknown op', `file /t.ts ${A}\nfrobnicate 3`, 'unknown-op', 2)
  expectError('bad range (reversed)', `file /t.ts ${A}\nreplace 9-3\n| x`, 'bad-range', 2)
  expectError('bad range (zero)', `file /t.ts ${A}\nreplace 0\n| x`, 'bad-range', 2)
  expectError('insert takes a single line', `file /t.ts ${A}\ninsert 3-5\n| x`, 'bad-range', 2)
  expectError('replace with no body', `file /t.ts ${A}\nreplace 3\ndelete 9`, 'body-missing', 2)
  expectError('trailing body-less replace', `file /t.ts ${A}\nreplace 3`, 'body-missing', 2)
  expectError('body row with no op', `file /t.ts ${A}\n| stray`, 'unknown-op', 2)
  expectError('marker missing its space', `file /t.ts ${A}\nreplace 3\n|x`, 'unknown-op', 3)
  expectError('register cut twice', `file /t.ts ${A}\ncut 1 into r\ncut 2 into r`, 'register-collision', 3)
  expectError('two anonymous cuts', `file /t.ts ${A}\ncut 1\ncut 2`, 'register-collision', 3)
  expectError('anonymous paste with no cut', `file /t.ts ${A}\npaste after 3`, 'register-empty')
  expectError('reserved register name', `file /t.ts ${A}\ncut 1 into after`, 'bad-register', 2)
  expectError('ops after delete-file', `file /t.ts ${A}\ndelete-file\nreplace 1\n| x`, 'ops-after-file-op', 3)
  expectError('delete-file after edits', `file /t.ts ${A}\nreplace 1\n| x\ndelete-file`, 'file-op-conflict', 4)
  expectError('two file ops', `file /t.ts ${A}\nmove-to /t2.ts\nmove-to /t3.ts`, 'ops-after-file-op', 3)
  expectError(
    'anchor conflict across same-path sections',
    `file /t.ts ${A}\nreplace 1\n| x\nfile /t.ts fa:ba9876543210\ndelete 9`,
    'anchor-conflict',
  )
  expectError('empty section', `file /t.ts ${A}\nfile /u.ts ${A}\ndelete 1`, 'bad-header', 1)
  const hugeBody = [`file /t.ts ${A}`, 'replace 1', ...Array.from({ length: ANCHOR_PATCH_BOUNDS.maxBodyLinesTotal + 1 }, () => '| x')].join('\n')
  expectError('amplification cap on body rows', hugeBody, 'amplification')
}

console.log('— T. bounded tolerance with repair warnings —')
{
  const fenced = ['```', `file /t.ts ${A}`, 'replace 1', '| x', '```'].join('\n')
  const r = parseAnchorPatch(fenced)
  check('code fence stripped', r.ok)
  if (r.ok) check('fence warning surfaced', r.warnings.some(w => w.code === 'fence-stripped'))
  const dash = parseAnchorPatch([`file /t.ts ${A}`, 'replace 3–5', '| x'].join('\n'))
  check('en-dash range accepted', dash.ok)
  if (dash.ok) check('range-spelling warning surfaced', dash.warnings.some(w => w.code === 'range-spelling'))
  const dots = parseAnchorPatch([`file /t.ts ${A}`, 'replace 3..5', '| x'].join('\n'))
  check('double-dot range accepted', dots.ok)
  const trail = parseAnchorPatch([`file /t.ts ${A}`, 'replace 3   ', '| x'].join('\n'))
  check('trailing space repaired', trail.ok)
  if (trail.ok) check('trailing-space warning surfaced', trail.warnings.some(w => w.code === 'trailing-space'))
}

console.log('— D. unified-diff contamination —')
{
  expectError('diff ---/+++ header', `file /t.ts ${A}\n--- a/t.ts`, 'unified-diff', 2)
  expectError('diff @@ hunk header', `file /t.ts ${A}\n@@ -1,3 +1,3 @@`, 'unified-diff', 2)
  expectError('bare +row', `file /t.ts ${A}\n+const x = 1`, 'unified-diff', 2)
  expectError('bare -row', `file /t.ts ${A}\n-const x = 1`, 'unified-diff', 2)
  const teach = parseAnchorPatch(`file /t.ts ${A}\n+++ b/t.ts`)
  check('the teaching text names the marker form', !teach.ok && (teach as Err).message.includes('| '))
}

console.log('')
if (failures > 0) {
  console.log(`RED: ${failures} failing check(s)`)
  process.exit(1)
}
console.log('GREEN: the anchor-patch grammar is total — every class parses or refuses typed')
