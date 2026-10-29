#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const cards = readFileSync(join(import.meta.dir, '../../src/components/concourse/ManagerCards.tsx'), 'utf8')
const seatCard = cards.slice(cards.indexOf('export function ManagerSeatAskCard'))

section('§1 THE FOCUS GATE')
{
  const promptMatch = /<PermissionPrompt[\s\n]/.exec(seatCard)
  const promptAt = promptMatch?.index ?? -1
  const promptSlice = seatCard.slice(promptAt, promptAt + 400)
  check('the seat card composes a PermissionPrompt', promptAt !== -1)
  check(
    'and it is focus-gated: isDisabled={!focused} (FC-025, the plan card law)',
    /isDisabled=\{!focused\}/.test(promptSlice),
    promptSlice.slice(0, 120).replace(/\s+/g, ' '),
  )
}

section('§2 THE REQUIRED PROP')
{
  const propsSlice = seatCard.slice(0, seatCard.indexOf('{') + 800)
  check(
    'focused is a REQUIRED prop (no ? — the caller cannot omit the fact)',
    /focused:\s*boolean/.test(propsSlice) && !/focused\?:/.test(propsSlice),
    propsSlice.match(/focused[^,\n]*/)?.[0] ?? '(absent)',
  )
}

section('§3 THE CALLER')
{
  const screen = readFileSync(join(import.meta.dir, '../../src/components/concourse/ConcourseScreen.tsx'), 'utf8')
  const callAt = screen.indexOf('<ManagerSeatAskCard')
  const callSlice = screen.slice(callAt, callAt + 400)
  check('the concourse screen mounts the seat card', callAt !== -1)
  check('and hands it the focus fact', /focused=\{/.test(callSlice), callSlice.slice(0, 160).replace(/\s+/g, ' '))
}

if (failures > 0) {
  console.error(`\nprove-seat-ask-focus: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-seat-ask-focus: all green')
