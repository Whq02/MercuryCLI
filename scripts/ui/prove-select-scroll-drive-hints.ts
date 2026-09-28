#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DRIVE = 'scripts/ui/prove-select-scroll-drive.ts'
const HINT = '⇧← back'
const { keyHintLabel, MAC_MODIFIER_GLYPHS } = await import(`${ROOT}/src/components/mercury-ui/keyHintLabel.ts`)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)

const codeOf = (body: string): string[] => {
  const out: string[] = []
  let inBlock = false
  for (const line of body.split('\n')) {
    let rest = line
    let code = ''
    for (;;) {
      if (inBlock) {
        const end = rest.indexOf('*/')
        if (end === -1) break
        rest = rest.slice(end + 2)
        inBlock = false
        continue
      }
      const start = rest.indexOf('/*')
      const slash = rest.indexOf('//')
      if (slash !== -1 && (start === -1 || slash < start)) {
        code += rest.slice(0, slash)
        break
      }
      if (start === -1) {
        code += rest
        break
      }
      code += rest.slice(0, start)
      rest = rest.slice(start + 2)
      inBlock = true
    }
    out.push(code)
  }
  return out
}

const source = readFileSync(join(ROOT, DRIVE), 'utf8')
const lines = codeOf(source)
const offMac = keyHintLabel(HINT, 'linux')

section('§1 the drive learns the pane from the footer row, and the footer speaks the host')
check('the drive reads the screen for the way-back hint', lines.some(l => l.includes(HINT)))
check('off macOS the product paints the hint in the host words, no Mac glyph left', offMac !== HINT && !MAC_MODIFIER_GLYPHS.some(g => offMac.includes(g)), offMac)

section('§2 every key hint the drive reads off the screen is folded to the host spelling')
const offenders: string[] = []
for (let i = 0; i < lines.length; i++) {
  const code = lines[i]!
  if (!MAC_MODIFIER_GLYPHS.some(g => code.includes(g))) continue
  if (lines.slice(Math.max(0, i - 2), i + 1).join('\n').includes('keyHintLabel(')) continue
  offenders.push(`${DRIVE}:${i + 1} ${code.trim().slice(0, 90)}`)
}
check(
  'no code line reads a Mac-only spelling: each glyph hint sits inside a keyHintLabel( fold',
  offenders.length === 0,
  `${offenders.join(' | ')} — a Linux host paints ${JSON.stringify(offMac)} there, so the row is never found and the pane bottom falls to a guessed row`,
)

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-select-scroll-drive-hints — ${failures === 0 ? 'all checks pass' : `${failures} check(s) failed`}`)
process.exit(failures === 0 ? 0 : 1)
