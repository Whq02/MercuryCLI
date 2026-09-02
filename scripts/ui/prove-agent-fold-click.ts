#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-agent-fold-click.ts — the agent-card fold is an HONEST
//  disclosure (field report: "+N more tool uses ⌄" but clicking
//  did nothing).
//
//    (1) the fold math is exported (hiddenAgentToolUses) and total on the
//        empty input;
//    (2) the progress renderer reveals the WHOLE fold under per-row verbose
//        (isTranscriptMode || verbose — the same law the Skill fold follows);
//    (3) Messages.isItemClickable advertises the click on BOTH rows the card
//        can render under (assistant tool_use + user tool_result), gated on
//        the fold actually hiding work — a ⌄ cue on a dead row is banned.
//  Run:  ~/.bun/bin/bun run scripts/ui/prove-agent-fold-click.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'fs'
import { join } from 'path'
import { hiddenAgentToolUses } from '../../src/tools/AgentTool/UI.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('agent-card fold: click reveals, cue never lies')

check('hiddenAgentToolUses is total on empty progress', hiddenAgentToolUses([], [] as never) === 0)

const repoRoot = join(import.meta.dir, '..', '..')
const agentUi = readFileSync(join(repoRoot, 'src/tools/AgentTool/UI.tsx'), 'utf8')
check(
  'agent progress fold honors per-row verbose (revealAll = isTranscriptMode || verbose)',
  /const revealAll = isTranscriptMode \|\| verbose/.test(agentUi),
)
check(
  'the hidden count comes from the ONE exported fold math',
  /hiddenToolUseCount = revealAll \? 0 : hiddenAgentToolUses\(progressMessages, tools\)/.test(agentUi),
)

const messages = readFileSync(join(repoRoot, 'src/components/Messages.tsx'), 'utf8')
check(
  'isItemClickable arms the assistant tool_use row on a hidden fold',
  /first\?\.type === 'tool_use' && isAgentToolName/.test(messages) &&
    /agentFoldHidden\(\(first as \{ id: string \}\)\.id\)/.test(messages),
)
check(
  'isItemClickable arms the tool_result row on a hidden fold (interrupt/error states)',
  /isAgentToolName\(lookupsRef\.current\.toolUseByToolUseID\.get\(b_0\.tool_use_id\)\?\.name\)/.test(messages) &&
    /agentFoldHidden\(b_0\.tool_use_id\)/.test(messages),
)
check(
  'global verbose disarms the toggle (no dead click when everything shows)',
  /!verbose &&\s*\n?\s*isAgentToolName/.test(messages) || /!verbose && agentFoldHidden/.test(messages),
)

console.log('\n' + '='.repeat(76))
if (failures === 0) {
  console.log('✅ AGENT FOLD CLICK: green')
  process.exit(0)
} else {
  console.log(`❌ AGENT FOLD CLICK: ${failures} check(s) failed`)
  process.exit(1)
}
