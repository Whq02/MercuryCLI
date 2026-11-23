#!/usr/bin/env bun
import fc from 'fast-check'
import { generateProgressiveArgumentHint, parseArgumentNames, parseArguments, substituteArguments } from '../../src/integrations/extensions/load/argumentSubstitution.ts'

const WHERE = 'src/integrations/extensions/load/argumentSubstitution.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

section('§1 parseArguments: the words of an argument text, in order')
{
  const table: Array<[string, string[], string]> = [
    ['', [], 'nothing gives no words'],
    ['   ', [], 'blank gives no words'],
    ['a b c', ['a', 'b', 'c'], 'words are split at spaces'],
    ['  a   b  ', ['a', 'b'], 'extra spaces do not make empty words'],
    ['tab\tsep\nnewline', ['tab', 'sep', 'newline'], 'tabs and line feeds split words too'],
    ['"hello world" x', ['hello world', 'x'], 'double quotes keep a phrase as one word'],
    ["'single quoted' y", ['single quoted', 'y'], 'single quotes do the same'],
    ['a\\ b c', ['a b', 'c'], 'a backslash keeps a space inside a word'],
    ['a=b --flag=1', ['a=b', '--flag=1'], 'equals signs and dashes are plain characters'],
    ['echo $HOME', ['echo', '$HOME'], 'a variable is not looked up: it stays as written'],
    ['$0 ${x}', ['$0', '$x'], 'a braced variable comes back without its braces'],
    ['a | b', ['a', 'b'], 'a pipe is not a word'],
    ['a > out.txt', ['a', 'out.txt'], 'a redirection is not a word'],
    ['a && b; c', ['a', 'b', 'c'], 'neither are the joining operators'],
    ['*.ts file', ['file'], 'a wildcard pattern is left out'],
    ['a # note', ['a'], 'a comment is left out'],
    ['"unclosed quote', ['unclosed', 'quote'], 'an unclosed double quote does not keep the phrase together'],
    ["it's", ['it', 's'], 'a lone apostrophe splits the word'],
  ]
  for (const [text, words, name] of table) check(`${name}: ${JSON.stringify(text)}`, same(parseArguments(text), words), `got ${JSON.stringify(parseArguments(text))}, expected ${JSON.stringify(words)}; see parseArguments in ${WHERE}`)
  const plain = fc.check(fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9_.:/=-]{1,12}$/), { maxLength: 8 }), words => same(parseArguments(words.join(' ')), words) && same(parseArguments(`  ${words.join('   ')}  `), words)), { numRuns: 500 })
  check('the law: words made of letters, digits and . _ : / = - come back as given, in order, however many spaces separate them', !plain.failed, `counterexample ${JSON.stringify(plain.counterexample)}; see parseArguments in ${WHERE}`)
  const quoted = fc.check(fc.property(fc.array(fc.stringMatching(/^[A-Za-z0-9 ]{1,12}$/), { minLength: 1, maxLength: 6 }), phrases => same(parseArguments(phrases.map(phrase => `"${phrase}"`).join(' ')), phrases)), { numRuns: 500 })
  check('the law: phrases in double quotes come back whole, spaces included', !quoted.failed, `counterexample ${JSON.stringify(quoted.counterexample)}; see parseArguments in ${WHERE}`)
}

section('§2 parseArgumentNames: the declared names')
{
  check('nothing declared gives no names', same(parseArgumentNames(undefined), []) && same(parseArgumentNames(''), []) && same(parseArgumentNames([]), []))
  check('a text is split at any run of spaces, in order', same(parseArgumentNames('a b  c'), ['a', 'b', 'c']) && same(parseArgumentNames('  lead trail  '), ['lead', 'trail']), JSON.stringify(parseArgumentNames('  lead trail  ')))
  check('a name made of digits only is not a name', same(parseArgumentNames('1 2 name'), ['name']) && same(parseArgumentNames(['007', 'b2']), ['b2']), JSON.stringify(parseArgumentNames('1 2 name')))
  check('from a list: texts are kept as they are, in order; empty, blank and non-text entries are dropped', same(parseArgumentNames(['a', '', ' ', '1', 'b2', 42, null, '007', 'x y'] as never), ['a', 'b2', 'x y']), JSON.stringify(parseArgumentNames(['a', '', ' ', '1', 'b2', 42, null, '007', 'x y'] as never)))
  check('anything that is neither a text nor a list gives no names', same(parseArgumentNames({} as never), []), `see parseArgumentNames in ${WHERE}`)
}

section('§3 generateProgressiveArgumentHint: the names still to type')
{
  check('with nothing typed, every name in brackets, in order, a space between', generateProgressiveArgumentHint(['a', 'b', 'c'], []) === '[a] [b] [c]')
  check('each typed argument takes the first name off', generateProgressiveArgumentHint(['a', 'b', 'c'], ['x']) === '[b] [c]' && generateProgressiveArgumentHint(['a', 'b', 'c'], ['x', 'y']) === '[c]')
  check('with every name typed, or more, or no names, there is no hint at all', generateProgressiveArgumentHint(['a', 'b', 'c'], ['x', 'y', 'z']) === undefined && generateProgressiveArgumentHint(['a'], ['x', 'y']) === undefined && generateProgressiveArgumentHint([], []) === undefined, `see generateProgressiveArgumentHint in ${WHERE}`)
}

section('§4 substituteArguments: placeholders in a text')
{
  const table: Array<[string, string | undefined, boolean | undefined, string[] | undefined, string, string]> = [
    ['run $ARGUMENTS now', 'x y', undefined, undefined, 'run x y now', '$ARGUMENTS becomes the whole argument text'],
    ['run $ARGUMENTS and $ARGUMENTS', '"a b" c', undefined, undefined, 'run "a b" c and "a b" c', 'every time it occurs, exactly as typed, quotes included'],
    ['first $ARGUMENTS[0] second $ARGUMENTS[1] third $ARGUMENTS[2].', '"a b" c', undefined, undefined, 'first a b second c third .', '$ARGUMENTS[n] becomes the word at place n, counting from 0; a place with no word becomes nothing'],
    ['$0-$1-$2', 'x y', undefined, undefined, 'x-y-', '$n is the same word by place'],
    ['$1abc $1 $10', 'x y', undefined, undefined, '$1abc y ', '$n directly followed by a letter is left alone; $10 is place ten'],
    ['cost $5.00 for $ARGUMENTS', 'it', undefined, undefined, 'cost .00 for it', 'a dollar amount is read as a place too'],
    ['$ARGUMENTS', '$& $1 $$', undefined, undefined, '$& $1 $$', 'dollar signs in the arguments are put in as they are'],
    ['$0', "'$1' second", undefined, undefined, '$1', 'a word that looks like a placeholder is put in and not replaced again'],
    ['has $ARGUMENTS', '', undefined, undefined, 'has ', 'empty arguments still clear the placeholder'],
    ['$name and $other!', 'v1 v2', true, ['name', 'other'], 'v1 and v2!', 'a declared name stands for the word at its own place'],
    ['$name $names $name[0] $name.', 'v1', true, ['name'], 'v1 $names $name[0] v1.', 'a declared name followed by a letter, a digit, an underscore or an opening bracket is left alone'],
    ['$a $b', 'only', true, ['a', 'b'], 'only ', 'a declared name with no word becomes nothing'],
    ['$n', 'v', true, ['', 'n'], '', 'an empty declared name is skipped but keeps its place'],
    ['$x', "'$1' second", true, ['x'], 'second', 'a declared name is replaced before the numbered places, so a word it brings in that looks like one is replaced after it'],
  ]
  for (const [content, args, append, names, want, name] of table) {
    const got = substituteArguments(content, args, append, names)
    check(`${name}: ${JSON.stringify(content)} with ${JSON.stringify(args)}`, got === want, `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}; see substituteArguments in ${WHERE}`)
  }
  check('a text with no placeholder gets the arguments added after a blank line, under the label ARGUMENTS:', substituteArguments('no placeholder', 'x y') === 'no placeholder\n\nARGUMENTS: x y' && substituteArguments('keep', 'x', true, []) === 'keep\n\nARGUMENTS: x', JSON.stringify(substituteArguments('no placeholder', 'x y')))
  check('unless told not to add them', substituteArguments('no placeholder', 'x y', false) === 'no placeholder')
  check('or the arguments are empty', substituteArguments('no placeholder', '') === 'no placeholder')
  check('with no arguments at all the text comes back untouched, placeholders included', substituteArguments('run $ARGUMENTS $0', undefined) === 'run $ARGUMENTS $0', `see substituteArguments in ${WHERE}`)
  const untouched = fc.check(fc.property(fc.stringMatching(/^[A-Za-z0-9 .,!?-]{0,40}$/), fc.stringMatching(/^[A-Za-z0-9]{1,10}$/), (content, args) => substituteArguments(content, args) === `${content}\n\nARGUMENTS: ${args}` && substituteArguments(content, args, false) === content), { numRuns: 500 })
  check('the law: a text with no dollar sign is never changed inside; the arguments are only added after it', !untouched.failed, `counterexample ${JSON.stringify(untouched.counterexample)}; see substituteArguments in ${WHERE}`)
}

if (failures > 0) {
  console.error(`\nprove-argument-substitution-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-argument-substitution-behaviour: all green')
