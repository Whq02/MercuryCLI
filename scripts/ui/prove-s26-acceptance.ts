#!/usr/bin/env bun

import { join } from 'node:path'

process.env.NODE_ENV = 'test'

import { hunkPatchText } from '../../src/screen/diff/DiffDialog.js'
import { getRelativeInstructionFilePath } from '../../src/screen/memory/instructionFilePath.js'
import {
  NULL_RENDERING_ATTACHMENT_TYPES,
  isNullRenderingAttachment,
} from '../../src/screen/messages/nullRenderingAttachments.js'

let failures = 0
let passes = 0
let s26SectionName = ''
function s26Where(): string {
  if (s26SectionName === 'hunk patch grammar') return 'change hunkPatchText in src/screen/diff/DiffDialog.tsx'
  if (s26SectionName === 'memory path helper') return 'change getRelativeInstructionFilePath in src/screen/memory/instructionFilePath.ts'
  return 'change NULL_RENDERING_ATTACHMENT_TYPES or isNullRenderingAttachment in src/screen/messages/nullRenderingAttachments.ts'
}
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passes++
    console.log(`  [PASS] ${label}`)
  } else {
    failures++
    console.log(`  [FAIL] ${label} — ${detail ? `${detail} · ` : ''}to fix: ${s26Where()}`)
  }
}
function section(name: string): void {
  s26SectionName = name
  console.log(`\n── ${name} ──`)
}

section('hunk patch grammar')
{
  const patch = hunkPatchText('src/a.ts', {
    oldStart: 3,
    oldLines: 2,
    newStart: 3,
    newLines: 3,
    lines: [' ctx', '-old', '+new', '+more'],
  } as never)
  const lines = patch.split('\n')
  check('header names the file on both sides', lines[0] === '--- a/src/a.ts' && lines[1] === '+++ b/src/a.ts')
  check('the @@ header carries -old,oldLines +new,newLines', lines[2] === '@@ -3,2 +3,3 @@')
  check('the hunk lines follow verbatim', lines[3] === ' ctx' && lines[5] === '+new')
  check('the patch is newline-terminated', patch.endsWith('+more\n'))
}

section('memory path helper')
{
  const { getCwd } = await import('../../src/platform/files/cwd.js')
  const os = await import('node:os')
  const cwd = getCwd()
  const inCwd = join(cwd, 'X.md')
  const rel = getRelativeInstructionFilePath(inCwd)
  check('a cwd file renders cwd-relative (./…) when shorter', rel === './X.md' || rel.startsWith('~'), `got ${rel}`)
  const home = os.homedir()
  const inHome = join(home, 'Y.md')
  check('a home file renders home-relative (~/…)', getRelativeInstructionFilePath(inHome) === '~/Y.md')
  check('an unrelated absolute path stays absolute', getRelativeInstructionFilePath('/opt/z.md') === '/opt/z.md')
}

section('null-rendering registry')
{
  const asMessage = (type: string) =>
    ({ type: 'attachment', attachment: { type } }) as never
  check(
    'the registry is a non-empty set with the membership predicate agreeing',
    NULL_RENDERING_ATTACHMENT_TYPES.length > 0 &&
      NULL_RENDERING_ATTACHMENT_TYPES.every(type =>
        isNullRenderingAttachment(asMessage(type)),
      ),
  )
  check('a rendered kind is NOT in the registry', !isNullRenderingAttachment(asMessage('file')))
}


console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s) · ${passes} passes`)
  process.exit(1)
}
console.log(`✓ S26 acceptance battery green — ${passes} checks`)
