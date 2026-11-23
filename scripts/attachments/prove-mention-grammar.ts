import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as mentions from '../../src/engine/attachment-shapes/mentions.js'

const baseline = process.argv.indexOf('--baseline')
if (baseline >= 0) {
  const rows = JSON.parse(readFileSync(process.argv[baseline + 1]!, 'utf8'))
  for (const row of rows) {
    assert.deepEqual(mentions.extractAtMentionedFiles(row.input), row.files, `extractAtMentionedFiles in src/engine/attachment-shapes/mentions.ts no longer matches the frozen baseline for input ${JSON.stringify(row.input)}`)
    assert.deepEqual(mentions.extractAgentMentions(row.input), row.agents, `extractAgentMentions in src/engine/attachment-shapes/mentions.ts no longer matches the frozen baseline for input ${JSON.stringify(row.input)}`)
    assert.deepEqual(mentions.extractMcpResourceMentions(row.input), row.resources, `extractMcpResourceMentions in src/engine/attachment-shapes/mentions.ts no longer matches the frozen baseline for input ${JSON.stringify(row.input)}`)
  }
  console.log(`PASS ${rows.length} frozen base grammar cases`)
}
assert.equal(typeof mentions.parseMentions, 'function', 'one shared mention grammar is available')
const input = '@a.ts#L10-2 @server:uri @"two words.ts" @"reviewer (agent)" @agent-code'
const parsed = mentions.parseMentions(input)
assert.deepEqual(parsed.files, ['two words.ts', 'a.ts#L10-2', 'server:uri', 'agent-code'], 'parseMentions in src/engine/attachment-shapes/mentions.ts returned the wrong files list for the sample prompt')
assert.deepEqual(parsed.agents, ['reviewer', 'agent-code'], 'parseMentions in src/engine/attachment-shapes/mentions.ts returned the wrong agents list for the sample prompt')
assert.deepEqual(parsed.resources, ['server:uri'], 'parseMentions in src/engine/attachment-shapes/mentions.ts returned the wrong resources list for the sample prompt')
assert.equal(parsed, mentions.parseMentions(input), 'all resolvers share one parsed prompt')
const files = mentions.extractAtMentionedFiles(input)
files.pop()
assert.deepEqual(mentions.extractAtMentionedFiles(input), parsed.files, 'callers cannot mutate the grammar result')
assert.deepEqual(mentions.parseAtMentionedFileLines('a.ts#L10-2'), { filename: 'a.ts', lineStart: 10, lineEnd: 10 }, 'parseAtMentionedFileLines in src/engine/attachment-shapes/mentions.ts must clamp a reversed range L10-2 to lineStart 10 and lineEnd 10')
assert.deepEqual(mentions.parseAtMentionedFileLines('a.ts#heading'), { filename: 'a.ts', lineStart: undefined, lineEnd: undefined }, 'parseAtMentionedFileLines in src/engine/attachment-shapes/mentions.ts must keep the filename and leave the lines undefined for a non-line fragment')
console.log('PASS shared mention grammar, compatibility views and reversed ranges')
