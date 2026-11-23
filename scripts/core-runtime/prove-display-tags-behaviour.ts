#!/usr/bin/env bun
import fc from 'fast-check'
import { stripDisplayTags, stripDisplayTagsAllowEmpty, stripIdeContextTags } from '../../src/screen/messages/displayTags.ts'

const WHERE = 'src/screen/messages/displayTags.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

section('§1 what the three functions make of the same text')
{
  const table: Array<[string, string, string, string, string]> = [
    ['plain', 'plain', 'plain', 'plain', 'a text with no tag is untouched'],
    ['<a>x</a>\nrest', 'rest', 'rest', '<a>x</a>\nrest', 'a tagged block goes, with the line feed after it'],
    ['<a>x</a>\n\nrest', 'rest', 'rest', '<a>x</a>\n\nrest', 'and what blank is left at the ends is trimmed'],
    ['before <tag attr="1">in</tag> after', 'before  after', 'before  after', 'before <tag attr="1">in</tag> after', 'a block inside a line goes and the spaces around it stay; attributes are part of the opening tag'],
    ['<a>\nmulti\nline\n</a>\ntail', 'tail', 'tail', '<a>\nmulti\nline\n</a>\ntail', 'a block may run over several lines'],
    ['<a-b_c>x</a-b_c>!', '!', '!', '<a-b_c>x</a-b_c>!', 'a tag name may hold dashes, underscores and digits after its first letter'],
    ['<A>x</A> kept', '<A>x</A> kept', '<A>x</A> kept', '<A>x</A> kept', 'a tag in capitals is not a display tag'],
    ['<1a>x</1a>', '<1a>x</1a>', '<1a>x</1a>', '<1a>x</1a>', 'nor one that begins with a digit'],
    ['<a>unclosed', '<a>unclosed', '<a>unclosed', '<a>unclosed', 'an opening tag with no closing one stays'],
    ['<a>x</b> y', '<a>x</b> y', '<a>x</b> y', '<a>x</b> y', 'a closing tag of another name does not close it'],
    ['text <a/> self', 'text <a/> self', 'text <a/> self', 'text <a/> self', 'a self-closing tag stays'],
    ['<a><a>in</a>out</a>', 'out</a>', 'out</a>', '<a><a>in</a>out</a>', 'a block ends at the first closing tag of its name'],
    ['<ide_opened_file>f</ide_opened_file> and <ide_selection>s</ide_selection> and <other>o</other>', 'and  and', 'and  and', 'and  and <other>o</other>', 'the editor-context stripper takes its two tags only'],
    ['<a>x</a>', '<a>x</a>', '', '<a>x</a>', 'a text that is all tags: the first function hands the text back whole, the second answers empty'],
    ['<a>one</a><b>two</b>', '<a>one</a><b>two</b>', '', '<a>one</a><b>two</b>', 'the same with two blocks'],
    ['  <a>x</a>  ', '  <a>x</a>  ', '', '<a>x</a>', 'and with spaces around: the whole text comes back with its spaces'],
    ['<a></a>', '<a></a>', '', '<a></a>', 'an empty block is a block'],
    ['   ', '   ', '', '', 'a blank text: the first hands it back as it is, the other two trim it to nothing'],
    ['', '', '', '', 'an empty text stays empty'],
  ]
  for (const [text, plain, allowEmpty, ide, name] of table) {
    const got = [stripDisplayTags(text), stripDisplayTagsAllowEmpty(text), stripIdeContextTags(text)]
    check(`${name}: ${JSON.stringify(text)}`, got[0] === plain && got[1] === allowEmpty && got[2] === ide, `got ${JSON.stringify(got)}, expected ${JSON.stringify([plain, allowEmpty, ide])}; see stripDisplayTags, stripDisplayTagsAllowEmpty and stripIdeContextTags in ${WHERE}`)
  }
}

section('§2 the laws, on generated texts')
{
  const words = fc.stringMatching(/^[A-Za-z0-9 .,!?]{0,30}$/)
  const tags = fc.constantFrom('note', 'system-reminder', 'ide_selection', 'ide_opened_file', 'x1', 'a_b')
  const noTags = fc.check(fc.property(words, text => stripDisplayTagsAllowEmpty(text) === text.trim() && stripIdeContextTags(text) === text.trim() && stripDisplayTags(text) === (text.trim() === '' ? text : text.trim())), { numRuns: 500 })
  check('a text with no angle bracket is only trimmed; if trimming leaves nothing, the first function hands back the text as given', !noTags.failed, `counterexample ${JSON.stringify(noTags.counterexample)}; see ${WHERE}`)
  const wrapped = fc.check(
    fc.property(words, tags, words, words, (before, tag, inside, after) => {
      const text = `${before}<${tag}>${inside}</${tag}>${after}`
      const rest = `${before}${after}`.trim()
      const editor = tag === 'ide_selection' || tag === 'ide_opened_file'
      return stripDisplayTagsAllowEmpty(text) === rest && stripDisplayTags(text) === (rest === '' ? text : rest) && stripIdeContextTags(text) === (editor ? rest : text.trim())
    }),
    { numRuns: 500 },
  )
  check('one block of any lower-case tag between two plain texts: the block goes and the two texts meet; the editor-context stripper does that for its two tags and leaves any other block in', !wrapped.failed, `counterexample ${JSON.stringify(wrapped.counterexample)}; see ${WHERE}`)
  const twice = fc.check(fc.property(words, tags, words, (before, tag, inside) => { const once = stripDisplayTagsAllowEmpty(`${before}<${tag}>${inside}</${tag}>`); return stripDisplayTagsAllowEmpty(once) === once }), { numRuns: 300 })
  check('stripping what was already stripped changes nothing', !twice.failed, `counterexample ${JSON.stringify(twice.counterexample)}; see ${WHERE}`)
}

if (failures > 0) {
  console.error(`\nprove-display-tags-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-display-tags-behaviour: all green')
