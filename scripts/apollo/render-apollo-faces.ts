#!/usr/bin/env bun

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = cond ? detail : [detail, hint].filter(Boolean).join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/platform/settings/config.ts')
enableConfigs()
const React = (await import('react')).default
const { renderToString } = await import('../../src/screen/renderer/staticRender.tsx')
const { Box, Text } = await import('../../src/screen/themedRenderer.js')
const { Select } = await import('../../src/screen/select/index.js')
const { apolloIndexLabel, apolloCustomIndexLabel } = await import(
  '../../src/tools/ask-question/apolloLetters.js'
)
const { ApolloReviewCard } = await import('../../src/tools/apollo-review/rows.js')

const authored = [
  { label: 'Top-down view', description: 'The whole board is visible at once' },
  { label: 'Side view', description: 'Classic platformer framing' },
  { label: 'First person', description: 'You see through the character’s eyes' },
  { label: 'Isometric', description: 'A tilted three-quarter view' },
]
const pollOptions = [
  ...authored.map((opt, index) => ({
    type: 'text' as const,
    value: opt.label,
    label: opt.label,
    description: opt.description,
    indexLabel: apolloIndexLabel(index),
  })),
  {
    type: 'input' as const,
    value: '__other__',
    label: 'Other',
    placeholder: 'Type something.',
    initialValue: '',
    onChange: () => {},
    indexLabel: apolloCustomIndexLabel(),
  },
]

function PollFace(): React.ReactElement {
  return React.createElement(
    Box,
    { flexDirection: 'column' },
    React.createElement(Text, { bold: true }, 'How should the game be seen? (the camera — viewpoint)'),
    React.createElement(Box, { marginTop: 1 }, React.createElement(Select, { options: pollOptions as never, layout: 'compact-vertical' })),
  )
}

const cleanCard = React.createElement(ApolloReviewCard, {
  summary:
    'A small top-down puzzle game: push crates onto targets across 5 hand-made levels. Arrow keys to move (input — keyboard only), one undo step, a move counter, and a win jingle per level.',
  blockers: [],
  specFiles: [
    '/tmp/demo-project/.mercury/apollo/spec.md',
    '/tmp/demo-project/.mercury/apollo/levels.md',
  ],
  runNote: 'open index.html in a browser — no install',
})
const blockedCard = React.createElement(ApolloReviewCard, {
  summary: 'The same puzzle game, but two decisions are still open.',
  blockers: [
    'Art direction is unsettled — hand-drawn or plain shapes changes every screen.',
    'No decision on sound — the win jingle needs a yes or no.',
  ],
  specFiles: ['/tmp/demo-project/.mercury/apollo/spec.md'],
})

console.log('============================================================')
console.log(' Apollo faces render-verify (poll letters + review card)')
console.log('============================================================')

for (const cols of [80, 120]) {
  console.log(`\n── @ ${cols} cols ──`)
  let poll = ''
  let clean = ''
  let blocked = ''
  try {
    poll = await renderToString(React.createElement(PollFace), cols)
    clean = await renderToString(cleanCard, cols)
    blocked = await renderToString(blockedCard, cols)
  } catch (e) {
    check(`renders complete at ${cols} cols`, false, String(e).split('\n')[0])
    continue
  }
  writeFileSync(join(tmpdir(), `apollo-poll-${cols}.txt`), poll)
  writeFileSync(join(tmpdir(), `apollo-review-clean-${cols}.txt`), clean)
  writeFileSync(join(tmpdir(), `apollo-review-blocked-${cols}.txt`), blocked)

  check(
    'the poll letters every authored option A–D ("A. label" — letters replace the numeric ordinals)',
    [/A\.\s+Top-down view/, /B\.\s+Side view/, /C\.\s+First person/, /D\.\s+Isometric/].every(re => re.test(poll)),
    '',
    'change apolloIndexLabel in src/tools/ask-question/apolloLetters.ts or the index label shown by src/screen/select; the text dump is in the tmp folder (apollo-poll-<cols>.txt)',
  )
  check("the custom route is lettered E (E = type my own)", /E\.\s+(Other|Type something)/.test(poll), '', 'change apolloCustomIndexLabel in src/tools/ask-question/apolloLetters.ts so the input option is lettered E')
  check('no numeric ordinals leak beside the letters', !/[1-5]\.\s*(Top-down|Side|First|Isometric|Other|Type something)/.test(poll) && !poll.includes('5.'), '', 'a numeric ordinal still renders next to the poll options; check the indexLabel handling in src/screen/select')
  check('the poll ties the plain question to its technical bridge', poll.includes('camera'), '', 'the poll text this script builds lost the word camera; see PollFace in this script')

  check('the review card leads with the ◇ seal + title', clean.includes('◇ Apollo pre-flight review') && blocked.includes('◇ Apollo pre-flight review'), '', 'change ApolloReviewCard in src/tools/apollo-review/rows.tsx so the title line reads Apollo pre-flight review')
  check('the clean card says no blockers', clean.includes('No blockers'), '', 'change the empty-blockers line of ApolloReviewCard in src/tools/apollo-review/rows.tsx')
  check('the clean card links the spec files', clean.includes('spec.md') && clean.includes('levels.md'), '', 'change the specFiles list of ApolloReviewCard in src/tools/apollo-review/rows.tsx')
  check('the clean card says where to run', clean.includes('Run it:') && clean.includes('index.html'), '', 'change the runNote line (Run it:) of ApolloReviewCard in src/tools/apollo-review/rows.tsx')
  check('the blockered card counts its blockers', blocked.includes('2 blockers remain:'), '', 'change the blocker count line of ApolloReviewCard in src/tools/apollo-review/rows.tsx')
  check('the blockered card lists each blocker', blocked.includes('Art direction') && blocked.includes('sound'), '', 'change the blocker list of ApolloReviewCard in src/tools/apollo-review/rows.tsx')
}

console.log(`\nText dumps: ${join(tmpdir(), 'apollo-{poll,review-clean,review-blocked}-{80,120}.txt')}`)
console.log(failures === 0 ? '\n✅ APOLLO FACES RENDER-VERIFY PASS' : `\n❌ ${failures} RENDER CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
