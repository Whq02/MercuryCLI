#!/usr/bin/env bun
import { marked } from 'marked'
import { configureMarked, hasMarkdownMarkers } from '../../src/utils/markdown.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

configureMarked()

{
  const plainSentence = 'the quick brown fox jumps over a lazy dog and keeps running until sunset; '
  let prose = ''
  while (prose.length < 600) prose += plainSentence
  const lateMarkdown = `${prose}\n# The heading after the sample\ntail prose`
  check('whole-text: late heading opens the gate', hasMarkdownMarkers(lateMarkdown))
  const tokens = marked.lexer(lateMarkdown)
  check('whole-text: the late heading lexes styled',
    tokens.some(t => t.type === 'heading'), JSON.stringify(tokens.map(t => t.type)))

  check('whole-text control: the prefix alone stays plain', !hasMarkdownMarkers(prose))
}

{
  const styledShapes: Array<[string, string, string]> = [
    ['plus-bullet list', '+ first item\n+ second item', 'list'],
    ['paren-ordered list', '1) first item\n2) second item', 'list'],
    ['setext = heading', 'The Title\n=========', 'heading'],
    ['setext - heading', 'The Title\n---------', 'heading'],
    ['late fenced code', 'intro prose\n\n```\ncode body\n```', 'code'],
  ]
  for (const [label, text, tokenType] of styledShapes) {
    check(`superset: ${label} opens the gate`, hasMarkdownMarkers(text))
    const tokens = marked.lexer(text)
    check(`superset: ${label} lexes to a ${tokenType} token`,
      tokens.some(t => t.type === tokenType),
      JSON.stringify(tokens.map(t => t.type)))
  }
}

{
  const words = [
    'ledger', 'терминал', 'harness', '漢字テスト', 'output', 'cadence',
    'the', 'sings', 'quietly', 'beside', 'row', 'threshold', 'signal',
  ]
  const punctuation = ['.', ',', ';', ':', '!', '?', '…', ')', '(', '"', "'", '/']
  const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000
  const rnd = lcg(0xa11ce)
  for (let i = 0; i < 40; i++) {
    const lineCount = 1 + Math.floor(rnd() * 4)
    const lines: string[] = []
    for (let l = 0; l < lineCount; l++) {
      const wordCount = 3 + Math.floor(rnd() * 9)
      const parts: string[] = []
      for (let w = 0; w < wordCount; w++) {
        parts.push(words[Math.floor(rnd() * words.length)]!)
        if (rnd() < 0.2) parts.push(`${1 + Math.floor(rnd() * 900)}${punctuation[Math.floor(rnd() * punctuation.length)]!}`)
      }
      lines.push(parts.join(' '))
    }
    const text = lines.join('\n')
    if (hasMarkdownMarkers(text)) {
      continue
    }
    const tokens = marked.lexer(text)
    const plainShaped = tokens.every(t =>
      t.type === 'space' ||
      (t.type === 'paragraph' &&
        (t as { tokens?: Array<{ type: string }> }).tokens?.every(inline => inline.type === 'text') === true))
    check(`plain-equivalence sample ${i}: paragraph/space tokens only`,
      plainShaped, JSON.stringify(tokens.map(t => t.type)))
  }

  const plainShapes = [
    'a bare sentence with no structure at all',
    'call me at 5 then we go',
    'the meeting is at 9:30 and runs long',
    'она читает книгу вечером',
  ]
  for (const text of plainShapes) {
    check(`plain-equivalence: ${JSON.stringify(text)} stays closed`, !hasMarkdownMarkers(text))
  }
}

console.log(failures === 0
  ? `\nmarkdown marker gate: green (${checks} checks)`
  : `\nmarkdown marker gate: ${failures} FAILURES of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
