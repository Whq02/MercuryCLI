#!/usr/bin/env bun
// prove-classify-tool-error.ts — table proof for the pure tool-error classifier
// (utils/errors/classifyToolError.ts, the trust-cockpit W2b card): headline
// extraction, stack-frame fold counting (frames NEVER leak into bodyLines),
// the body cap (default 9 ⇒ 1 + 9 matches the legacy 10-line ceiling), the
// errno hint table, and the honest empty/whitespace/frames-only edges.

import { classifyToolError } from '../../src/utils/errors/classifyToolError.js'

let fail = 0
const t = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// 1) Plain single-line error: headline only, nothing else.
{
  const r = classifyToolError('Error: something broke')
  t(
    'plain error ⇒ headline only',
    r.firstLine === 'Error: something broke' &&
      r.bodyLines.length === 0 &&
      r.stackFrameCount === 0 &&
      r.hint === undefined,
    JSON.stringify(r),
  )
}

// 2) Multi-line error: body preserved in order, no fold.
{
  const r = classifyToolError('Error: build failed\nexpected 3 args\ngot 1')
  t(
    'multi-line ⇒ ordered body',
    r.firstLine === 'Error: build failed' &&
      r.bodyLines.join('|') === 'expected 3 args|got 1' &&
      r.stackFrameCount === 0,
    JSON.stringify(r),
  )
}

// 3) Deep stack: frames counted, EXCLUDED from body; interleaved non-frame kept.
{
  const frames = Array.from({ length: 14 }, (_, i) => `    at fn${i} (file.ts:${i}:1)`)
  const r = classifyToolError(
    ['TypeError: x is not a function', ...frames.slice(0, 7), 'Caused by: boom', ...frames.slice(7)].join('\n'),
  )
  t(
    'deep stack ⇒ 14 frames counted, none in body',
    r.stackFrameCount === 14 &&
      r.bodyLines.join('|') === 'Caused by: boom' &&
      r.bodyLines.every(l => !/^\s+at /.test(l)),
    JSON.stringify(r),
  )
}

// 4-7) The errno hint table (one per class; ENOENT wins inside a stack too).
{
  const r = classifyToolError("ENOENT: no such file or directory, open '/tmp/x'\n    at Object.openSync (node:fs:601:3)")
  t('ENOENT ⇒ path hint + frame counted', r.hint === 'path does not exist — check the cwd/spelling' && r.stackFrameCount === 1, JSON.stringify(r))
}
// The permission row is PLATFORM-HONEST: pin both arms
// explicitly so the table proves identically on every host.
const UNIX_PERM_HINT = 'permission denied — check file modes/ownership'
t('EACCES ⇒ permission hint (posix arm)', classifyToolError("EACCES: permission denied, open '/etc/shadow'", undefined, 'darwin').hint === UNIX_PERM_HINT)
t('EPERM ⇒ permission hint (posix arm)', classifyToolError('EPERM: operation not permitted, unlink', undefined, 'linux').hint === UNIX_PERM_HINT)
{
  const winHint = classifyToolError('EPERM: operation not permitted, rename', undefined, 'win32').hint ?? ''
  t(
    'win32 EPERM ⇒ file-in-use guidance naming the real actors, never chmod',
    /file in use/.test(winHint) && /antivirus/.test(winHint) && /retried/.test(winHint) && !/modes\/ownership/.test(winHint),
    winHint,
  )
  t('win32 EBUSY ⇒ the same file-in-use guidance', classifyToolError('EBUSY: resource busy or locked, rename', undefined, 'win32').hint === classifyToolError('EACCES: x', undefined, 'win32').hint)
  t('posix EBUSY ⇒ NO ownership hint (EBUSY is not a modes problem on unix)', classifyToolError('EBUSY: resource busy or locked', undefined, 'darwin').hint === undefined)
  t('live-platform default matches the pinned arm', classifyToolError('EPERM: x').hint === classifyToolError('EPERM: x', undefined, process.platform).hint)
}
t('ETIMEDOUT ⇒ timeout hint', classifyToolError('connect ETIMEDOUT 10.0.0.1:443').hint === 'timed out — retry or raise the timeout')
t('"timed out" prose (case-insensitive) ⇒ timeout hint', classifyToolError('Error: Command Timed Out after 120000ms').hint === 'timed out — retry or raise the timeout')
t('ENOSPC ⇒ disk-full hint', classifyToolError('ENOSPC: no space left on device, write').hint === 'disk full')
t('no known class ⇒ no hint (never fabricate)', classifyToolError('Error: kaboom').hint === undefined)

// 8) Empty string: honest empties across the board.
{
  const r = classifyToolError('')
  t('empty string ⇒ all-empty result', r.firstLine === '' && r.bodyLines.length === 0 && r.stackFrameCount === 0 && r.hint === undefined, JSON.stringify(r))
}

// 9) Whitespace-only: same as empty (no fabricated headline).
{
  const r = classifyToolError('  \n\t\n   ')
  t('whitespace-only ⇒ all-empty result', r.firstLine === '' && r.bodyLines.length === 0 && r.stackFrameCount === 0, JSON.stringify(r))
}

// 10) JSON blob body: lines preserved verbatim (indentation intact), no frame
//     false-positives on JSON keys.
{
  const r = classifyToolError('Error: API rejected the request\n{\n  "type": "error",\n  "attempt": 2\n}')
  t(
    'JSON blob ⇒ body verbatim, zero frames',
    r.firstLine === 'Error: API rejected the request' &&
      r.bodyLines.join('|') === '{|  "type": "error",|  "attempt": 2|}' &&
      r.stackFrameCount === 0,
    JSON.stringify(r),
  )
}

// 11) Frames-only: no headline to fabricate; every line counted as a frame.
{
  const r = classifyToolError('    at a (x.ts:1:1)\n    at b (y.ts:2:2)')
  t('frames-only ⇒ empty headline, 2 frames', r.firstLine === '' && r.bodyLines.length === 0 && r.stackFrameCount === 2, JSON.stringify(r))
}

// 12) Body cap: default 9; explicit cap respected; cap<0 clamps to 0.
{
  const twenty = ['Error: head', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)].join('\n')
  t('default cap ⇒ 9 body lines', classifyToolError(twenty).bodyLines.length === 9)
  t('cap=3 ⇒ 3 body lines, first-N order', classifyToolError(twenty, 3).bodyLines.join('|') === 'line 0|line 1|line 2')
  t('cap=0 ⇒ empty body', classifyToolError(twenty, 0).bodyLines.length === 0)
  t('negative cap clamps to 0', classifyToolError(twenty, -5).bodyLines.length === 0)
  t('uncapped (MAX_SAFE_INTEGER) ⇒ full body', classifyToolError(twenty, Number.MAX_SAFE_INTEGER).bodyLines.length === 20)
}

// 13) Blank-line hygiene: leading/trailing blanks dropped, interior kept.
{
  const r = classifyToolError('Error: x\n\nmid one\n\nmid two\n\n')
  t('leading/trailing blanks dropped, interior kept', r.bodyLines.join('|') === 'mid one||mid two', JSON.stringify(r))
}

// 14) Hint precedence: first class in table order wins on a multi-class blob.
t(
  'ENOENT outranks timeout when both present',
  classifyToolError('ENOENT: no such file (request timed out)').hint === 'path does not exist — check the cwd/spelling',
)

console.log(fail ? '\nRED — classify-tool-error' : '\nGREEN — classify-tool-error table holds')
process.exit(fail)
