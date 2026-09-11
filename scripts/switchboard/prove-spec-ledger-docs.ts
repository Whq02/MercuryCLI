#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const root = join(import.meta.dir, '..', '..')
const doc = readFileSync(join(root, 'docs', 'SESSIONS.md'), 'utf8').replace(/\s+/g, ' ')
const screen = readFileSync(join(root, 'src', 'components', 'concourse', 'ConcourseScreen.tsx'), 'utf8')
const route = readFileSync(join(root, 'src', 'components', 'concourse', 'ConcourseRoute.tsx'), 'utf8')

console.log('============================================================')
console.log(' spec-ledger docs — the older-chats browse (L20) in the doc')
console.log('============================================================')

{
  check('the doc keeps the census line spelling', doc.includes('N older chats · ↵ to'))
  check('…and says ↵ unfolds the list in place on the board', doc.includes('unfolds that very list in place on the board'))
  check('…with esc folding it back to the line', doc.includes('folds it back to the line'))
  check('…through the same door a parked row rides', doc.includes('the same door a parked row rides'))
  check('…with the honest tail arithmetic', doc.includes('+N more — /resume'))
}

{
  const toothA = ['own', 'session list'].join(' ')
  const toothB = ['in the chat', 'frame'].join(' ')
  check('the doc never says the ↵ opens the session list in the chat frame', !(doc.includes(toothA) && doc.includes(toothB)))
}

{
  check('the screen owns the in-place unfold (the unfold handler lives on the screen)', screen.includes('const unfoldOlderList = (row: ConcourseRowV1): void => {'))
  check('…reads the census the line counted', screen.includes('olderChatsCensus('))
  check('…and folds on esc', screen.includes('esc folds'))
  check('the route reactivates a pick through the one resume door', route.includes('resumeOlderChat'))
}

{
  check('the retention sentence stands (nothing deletes a transcript)', doc.includes('Nothing deletes a transcript'))
}

console.log(failures === 0 ? '\n✅ prove-spec-ledger-docs — all checks pass' : '\n❌ prove-spec-ledger-docs — check(s) failed')
process.exit(failures)
