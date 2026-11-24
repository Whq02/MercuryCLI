#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { getFoldUserSummaryMessage } = await import('../../src/engine/compaction/summariserPrompt.ts')

let failures = 0
const HINT = 'check getFoldUserSummaryMessage and formatSummary in src/engine/compaction/summariserPrompt.ts so replacement dollar patterns ($&, $$, $`, $\', $1) stay verbatim'
const check = (label: string, good: boolean, detail = ''): void => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${good ? (detail ? ` — ${detail}` : '') : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!good) failures++
}
const show = (text: string): string => JSON.stringify(text.length > 150 ? `${text.slice(0, 150)}…` : text)

const cases: Array<[string, string]> = [
  ['a plain summary (control)', '1. Operator Intent:\n   the build is green'],
  ['$& (the whole match, as sed and regex talk writes it)', "1. ran `sed 's/a/[$&]/' notes.txt` on every file"],
  ["$$ (a shell's own pid, a price)", '1. the lock file is /tmp/run.$$ and the cost was $$5'],
  ['$` (what stands before the match)', '1. the prompt ends in $` by mistake'],
  ["$' (what stands after the match)", "1. the awk program prints $' and stops"],
  ['$1 (a capture, as a regex replacement writes it)', '1. the rename maps (\\w+)Tool to $1Door'],
]
for (const [label, inner] of cases) {
  const raw = `<analysis>\nthinking it over\n</analysis>\n\n<summary>\n${inner}\n</summary>\n\nafter the block`
  const out = getFoldUserSummaryMessage(raw)
  const want = `Summary:\n${inner}`
  const at = out.indexOf('Summary:\n')
  const got = at === -1 ? '' : out.slice(at, at + want.length + 40)
  check(`${label}: the summary's text goes back letter for letter`, out.includes(`${want}\n\nafter the block`), `the message holds ${show(got)}`)
  check(`${label}: no tag of the block is left in the message`, !out.includes('<summary>') && !out.includes('</summary>') && !out.includes('<analysis>'))
}
console.log(failures === 0 ? `all ${cases.length * 2} hold` : `${failures} of ${cases.length * 2} fail`)
process.exit(failures === 0 ? 0 : 1)
export {}
