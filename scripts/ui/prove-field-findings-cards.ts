#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
    console.error('      to fix: a typed capital letter is decoded by interpretKey in src/screen/renderer/input/interpreter.ts (it must set name and shift), and the binding match is matchesKeystroke in src/screen/keys/match.ts with parseKeystroke in src/screen/keys/parser.ts')
  }
}

console.log('§1 PD-1 — the confirm chord disarms while a feedback field owns focus')
{
  const { interpretKey } = await import('../../src/screen/renderer/input/interpreter.ts')
  const { matchesKeystroke } = await import('../../src/screen/keys/match.ts')
  const { parseKeystroke } = await import('../../src/screen/keys/parser.ts')
  const parsed = interpretKey('N')
  check("the decoder names a typed 'N' as shift+n (shift synthesised from case)", parsed.name === 'n' && parsed.shift === true)
  const key = { ctrl: false, meta: false, shift: true, super: false } as unknown as Parameters<typeof matchesKeystroke>[1]
  check("the matcher accepts that keystroke for the 'shift+n' binding — why the gate must exist", matchesKeystroke('N', key, parseKeystroke('shift+n')))
}


process.exit(failures === 0 ? 0 : 1)
