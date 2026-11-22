#!/usr/bin/env bun
import fc from 'fast-check'
import { BASH_MODE_CHARACTER, getModeFromInput, getValueFromInput, isInputModeCharacter } from '../../src/components/PromptInput/inputModes.ts'

const WHERE = 'src/components/PromptInput/inputModes.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

console.log('§1 the mode character')
check('it is the exclamation mark', BASH_MODE_CHARACTER === '!', `${JSON.stringify(BASH_MODE_CHARACTER)}; see BASH_MODE_CHARACTER in ${WHERE}`)
check('isInputModeCharacter is true for it alone', isInputModeCharacter('!') && ['', ' ', '!!', '! ', '/', '#', '$', 'a', '\uff01'].every(char => !isInputModeCharacter(char)), `see isInputModeCharacter in ${WHERE}`)

console.log('§2 the mode and the value of what is typed')
{
  const table: Array<[string, string, string]> = [
    ['', 'prompt', ''],
    ['hello', 'prompt', 'hello'],
    ['!', 'bash', ''],
    ['!ls -la', 'bash', 'ls -la'],
    ['! ls', 'bash', ' ls'],
    ['!!', 'bash', '!'],
    [' !ls', 'prompt', ' !ls'],
    ['say !hi', 'prompt', 'say !hi'],
    ['/help', 'prompt', '/help'],
    ['\n!ls', 'prompt', '\n!ls'],
    ['!line one\nline two', 'bash', 'line one\nline two'],
  ]
  for (const [text, mode, value] of table) check(`${JSON.stringify(text)} is ${mode} with the value ${JSON.stringify(value)}`, getModeFromInput(text) === mode && getValueFromInput(text) === value, `got ${getModeFromInput(text)} and ${JSON.stringify(getValueFromInput(text))}; see getModeFromInput and getValueFromInput in ${WHERE}`)
}

console.log('§3 the laws, on generated text')
{
  const marked = fc.check(fc.property(fc.string(), text => getModeFromInput(`!${text}`) === 'bash' && getValueFromInput(`!${text}`) === text), { numRuns: 500 })
  check('any text behind the mark is bash, and its value is the text without the one mark', !marked.failed, `counterexample ${JSON.stringify(marked.counterexample)}; see ${WHERE}`)
  const plain = fc.check(fc.property(fc.string().filter(text => !text.startsWith('!')), text => getModeFromInput(text) === 'prompt' && getValueFromInput(text) === text), { numRuns: 500 })
  check('any text that does not begin with the mark is a prompt, and its value is the text itself', !plain.failed, `counterexample ${JSON.stringify(plain.counterexample)}; see ${WHERE}`)
}

if (failures > 0) {
  console.error(`\nprove-input-modes-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-input-modes-behaviour: all green')
