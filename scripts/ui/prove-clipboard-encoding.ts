#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { windowsClipInput } from '../../src/ink/termio/osc.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}

console.log('── the Windows clipboard encoding law ──')

const SAMPLE = 'em—dash · box ─│╭╮ · accents éüñ · check ✓ · non-BMP \u{10348} · plain ascii'
const buf = windowsClipInput(SAMPLE)
check('BOM leads the stream (FF FE)', buf[0] === 0xff && buf[1] === 0xfe)
check('payload is UTF-16LE and round-trips exactly', buf.subarray(2).toString('utf16le') === SAMPLE)
check('no UTF-8 bytes leak (an odd payload length would betray one)', (buf.length - 2) % 2 === 0)
{
  const empty = windowsClipInput('')
  check('empty text still carries the BOM (clip sees Unicode, not locale)', empty.length === 2 && empty[0] === 0xff && empty[1] === 0xfe)
}

const oscSrc = readFileSync(join(ROOT, 'src', 'ink', 'termio', 'osc.ts'), 'utf8')
{
  const winBranch = /case 'win32':([\s\S]*?)return/.exec(oscSrc)?.[1] ?? ''
  check("the win32 copyNative branch exists", winBranch !== '')
  check('clip is fed windowsClipInput(text), never the raw string', winBranch.includes('input: windowsClipInput(text)'))
  check('the raw-opts form is gone from the win32 branch', !winBranch.includes("execFileNoThrow('clip', [], opts)"))
}

check('OSC 52 payload is base64 of UTF-8', oscSrc.includes("Buffer.from(text, 'utf8').toString('base64')"))

const execSrc = readFileSync(join(ROOT, 'src', 'utils', 'execFileNoThrow.ts'), 'utf8')
check('execFileNoThrow accepts Buffer input (both option types)', (execSrc.match(/input\?: string \| Buffer/g) ?? []).length === 2)

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ CLIPBOARD ENCODING PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
