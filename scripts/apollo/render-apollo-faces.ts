#!/usr/bin/env bun
// ============================================================================
//  scripts/apollo/render-apollo-faces.ts — component render-verify for the
//  Apollo faces at 80 AND 120 columns:
//    · the interview poll's answer face — the REAL Select owner fed by the
//      REAL letter grammar (apolloLetters.ts), exactly the option list
//      QuestionView builds in apollo mode: A–D + "E. Other";
//    · the closing review card (ApolloReviewCard) — clean and blockered.
//
//  Renders through the established off-screen harness (staticRender.tsx —
//  the prove-degradation-order precedent) and writes the text dumps to
//  /tmp/apollo-*.txt for the lead to LOOK at. The full-journey band capture
//  rides scripts/ui/render-permission-modes.ts (the real binary); a LIVE
//  poll needs a real model turn, so this is the deterministic face — a
//  ratchet, never the closing visual evidence.
//
//  Run:  ~/.bun/bin/bun run scripts/apollo/render-apollo-faces.ts
// ============================================================================

import { writeFileSync } from 'node:fs'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const React = (await import('react')).default
const { renderToString } = await import('../../src/utils/staticRender.tsx')
const { Box, Text } = await import('../../src/ink.js')
const { Select } = await import('../../src/components/CustomSelect/index.js')
const { apolloIndexLabel, apolloCustomIndexLabel } = await import(
  '../../src/tools/AskUserQuestionTool/apolloLetters.js'
)
const { ApolloReviewCard } = await import('../../src/tools/ApolloReviewTool/UI.js')

// ── the poll answer face (the QuestionView option-list construction) ───────
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

// ── the review card, both moments ──────────────────────────────────────────
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
  writeFileSync(`/tmp/apollo-poll-${cols}.txt`, poll)
  writeFileSync(`/tmp/apollo-review-clean-${cols}.txt`, clean)
  writeFileSync(`/tmp/apollo-review-blocked-${cols}.txt`, blocked)

  // The declared-ordinal grammar guarantees "A. " — letter, dot, at least
  // one space — so the space is REQUIRED here (\s+ absorbs any extra row
  // chrome). The E row's face is the free-text option: its cell shows the
  // label when focused/filled and the placeholder when idle — both accepted.
  check(
    'the poll letters every authored option A–D ("A. label" — letters replace the numeric ordinals)',
    [/A\.\s+Top-down view/, /B\.\s+Side view/, /C\.\s+First person/, /D\.\s+Isometric/].every(re => re.test(poll)),
  )
  check("the custom route is lettered E (E = type my own)", /E\.\s+(Other|Type something)/.test(poll))
  check('no numeric ordinals leak beside the letters', !/[1-5]\.\s*(Top-down|Side|First|Isometric|Other|Type something)/.test(poll) && !poll.includes('5.'))
  check('the poll ties the plain question to its technical bridge', poll.includes('camera'))

  check('the review card leads with the ∵ seal + title', clean.includes('∵') && clean.includes('Apollo pre-flight review'))
  check('the clean card says no blockers', clean.includes('No blockers'))
  check('the clean card links the spec files', clean.includes('spec.md') && clean.includes('levels.md'))
  check('the clean card says where to run', clean.includes('Run it:') && clean.includes('index.html'))
  check('the blockered card counts its blockers', blocked.includes('2 blockers remain:'))
  check('the blockered card lists each blocker', blocked.includes('Art direction') && blocked.includes('sound'))
}

console.log('\nText dumps: /tmp/apollo-{poll,review-clean,review-blocked}-{80,120}.txt')
console.log(failures === 0 ? '\n✅ APOLLO FACES RENDER-VERIFY PASS' : `\n❌ ${failures} RENDER CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
