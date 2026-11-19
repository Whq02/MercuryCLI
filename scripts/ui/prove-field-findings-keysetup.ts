#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 CI-03 — the instruction teaches the gesture that works')
{
  const { isBackslashContinuation } = await import('../../src/input-core/backslashContinuation.ts')
  const one = 'hello \\'
  const two = 'hello \\\\'
  check('the mechanism: one trailing backslash continues, two read as a UNC prefix and submit', isBackslashContinuation(one, one.length) === true && isBackslashContinuation(two, two.length) === false)
}

process.exit(failures === 0 ? 0 : 1)
