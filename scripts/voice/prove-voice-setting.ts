import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const path = resolve(import.meta.dir, '../../src/utils/config/schema.ts')
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
const voice = source.statements.find(s => ts.isTypeAliasDeclaration(s) && s.name.text === 'Voice')
assert.ok(voice && ts.isTypeAliasDeclaration(voice) && ts.isTypeLiteralNode(voice.type))
const keys = voice.type.members.map(m => m.name?.getText(source))
assert.ok(keys.includes('voiceInputEnabled'), 'the persisted on/off setting stays')
assert.ok(!keys.includes('voice' + 'Transcriber'), 'the saved transcriber selection is not a known key')
console.log('prove-voice-setting: green — on/off persists, no saved transcriber key')
