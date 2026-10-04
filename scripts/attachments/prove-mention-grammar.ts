import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as mentions from '../../src/utils/attachments/mentions.js'

const baseline = process.argv.indexOf('--baseline')
if (baseline >= 0) {
  const rows = JSON.parse(readFileSync(process.argv[baseline + 1]!, 'utf8'))
  for (const row of rows) {
    assert.deepEqual(mentions.extractAtMentionedFiles(row.input), row.files)
    assert.deepEqual(mentions.extractAgentMentions(row.input), row.agents)
    assert.deepEqual(mentions.extractMcpResourceMentions(row.input), row.resources)
  }
  console.log(`PASS ${rows.length} frozen base grammar cases`)
}
assert.equal(typeof mentions.parseMentions, 'function', 'one shared mention grammar is available')
const input = '@a.ts#L10-2 @server:uri @"two words.ts" @"reviewer (agent)" @agent-code'
const parsed = mentions.parseMentions(input)
assert.deepEqual(parsed.files, ['two words.ts', 'a.ts#L10-2', 'server:uri', 'agent-code'])
assert.deepEqual(parsed.agents, ['reviewer', 'agent-code'])
assert.deepEqual(parsed.resources, ['server:uri'])
assert.equal(parsed, mentions.parseMentions(input), 'all resolvers share one parsed prompt')
const files = mentions.extractAtMentionedFiles(input)
files.pop()
assert.deepEqual(mentions.extractAtMentionedFiles(input), parsed.files, 'callers cannot mutate the grammar result')
assert.deepEqual(mentions.parseAtMentionedFileLines('a.ts#L10-2'), { filename: 'a.ts', lineStart: 10, lineEnd: 10 })
assert.deepEqual(mentions.parseAtMentionedFileLines('a.ts#heading'), { filename: 'a.ts', lineStart: undefined, lineEnd: undefined })
console.log('PASS shared mention grammar, compatibility views and reversed ranges')
