#!/usr/bin/env bun
(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { parseFamilyFocus } = await import('../../src/commands/logins/login.tsx')
const { reconnectDoorFor } = await import('../../src/models/roads/credentialWall.ts')

section('§1 the family-focus vocabulary (pure)')
{
  const rows: Array<[string, string]> = [
    ['anthropic', 'anthropic'],
    ['claude', 'anthropic'],
    ['claudeai', 'anthropic'],
    ['console', 'anthropic'],
    ['openai', 'openai'],
    ['chatgpt', 'openai'],
    ['gpt', 'openai'],
    ['openrouter', 'openrouter'],
    ['gemini', 'gemini'],
    ['google', 'gemini'],
    ['huggingface', 'huggingface'],
    ['hf', 'huggingface'],
    ['moonshot', 'moonshot'],
    ['kimi', 'moonshot'],
    ['zai', 'zai'],
    ['glm', 'zai'],
    ['deepseek', 'deepseek'],
  ]
  for (const [word, focus] of rows) {
    check(`'${word}' pre-focuses ${focus}`, parseFamilyFocus(word) === focus, `parseFamilyFocus returned ${String(parseFamilyFocus(word))}; fix the word-to-family table in parseFamilyFocus in src/commands/logins/login.tsx`)
  }
  check('an unknown word opens the menu unfocused (never a crash)', parseFamilyFocus('galactica') === undefined && parseFamilyFocus(undefined) === undefined, 'fix parseFamilyFocus in src/commands/logins/login.tsx so a word outside its table and an undefined word both return undefined')
}


section('§5 every wall reconnect door lands focused; the /accounts reroute rides it')
{
  const families = ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek', 'openai-compat', 'local', 'unknown-future-family']
  for (const family of families) {
    const door = reconnectDoorFor(family)
    if (door.startsWith('/logins ')) {
      const word = door.slice('/logins '.length).trim()
      check(`the ${family} wall door ('${door}') pre-focuses a real row`, parseFamilyFocus(word) !== undefined, `parseFamilyFocus has no row for '${word}'; fix reconnectDoorFor in src/models/roads/credentialWall.ts to name a word parseFamilyFocus knows, or add the word to parseFamilyFocus in src/commands/logins/login.tsx`)
    } else {
      check(`the ${family} door is its own named road ('${door}')`, door.startsWith('/') || /^[A-Z][A-Z0-9_]+$/.test(door), `reconnectDoorFor returned '${door}'; fix reconnectDoorFor in src/models/roads/credentialWall.ts to return a /logins word, another slash command, or an upper-case environment variable name`)
    }
  }
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('REAUTH LANDS HOME: ALL GREEN')
else console.log(`❌ ${failures} REAUTH-ROAD LAW(S) BROKEN`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
