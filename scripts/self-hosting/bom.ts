#!/usr/bin/env bun
// ============================================================================
//  scripts/self-hosting/bom.ts — the request-context BILL OF MATERIALS
//
//
//  Composes the REAL runtime request context — the same getSystemPrompt() →
//  composeSystemPrompt() → behaviour-contract path the API request rides, plus
//  the instruction engine's project block and the memdir prompt — and prints
//  every block with its semantic id, producer group, owner, provider scope,
//  cache class and exact size. No network; no writes outside stdout.
//
//  Modes (one per invocation; a driver loops):
//    interactive   — the default interactive composition (also covers the
//                    tool-heavy-edit shape: the tool POOL is constant per
//                    session; tool RESULTS are conversation, not prompt)
//    plan          — permissionMode 'strategy'
//    subagent      — the spawned-agent prompt (DEFAULT_AGENT_PROMPT +
//                    enhanceSystemPromptWithEnvDetails)
//    headless      — non-interactive session guidance variant
//  Instruction modes ride --cwd (the engine walks from CWD): mercury-native /
//  claude-import / no-instructions fixtures, or this repo itself.
//
//  Usage:
//    bun run scripts/self-hosting/bom.ts --model claude-fable-5 \
//      --mode interactive [--json]
// ============================================================================
import { parseArgs } from 'util'

// MACRO is a build-time define; under source `bun run` it must be shimmed
// (the scripts/verify runner precedent).
;(globalThis as Record<string, unknown>).MACRO = (globalThis as Record<string, unknown>).MACRO ?? {
  VERSION: '0.0.0-bom',
  ISSUES_EXPLAINER: 'report via /feedback',
  FEEDBACK_CHANNEL: '/feedback',
}

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'claude-fable-5[1m]' },
    mode: { type: 'string', default: 'interactive' },
    json: { type: 'boolean', default: false },
  },
})
const model = values.model!
const mode = values.mode!

// Keep the composition deterministic and offline: no MCP, no analytics noise.
process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
delete process.env.MERCURY_SIMPLE

// Config must be enabled before the tool pool / permission rules resolve.
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

if (mode === 'headless') {
  const { setIsInteractive } = await import('../../src/bootstrap/state.js')
  setIsInteractive(false)
}

const { getSystemPrompt, DEFAULT_AGENT_PROMPT, enhanceSystemPromptWithEnvDetails } =
  await import('../../src/constants/prompts.js')
// The UNFILTERED base pool: composition only needs tool NAMES for the
// enabled-tool guidance sections; the permission-filtered pool needs a booted
// ToolPermissionContext this diagnostic deliberately does not construct.
const { getAllBaseTools } = await import('../../src/tools.js')
const { readPromptProvenance } = await import(
  '../../src/utils/cockpit/promptProvenance.js'
)
const { getInstructionBundle } = await import(
  '../../src/services/instructions/engine.js'
)
const { getInstructionCompositionState } = await import(
  '../../src/services/instructions/engine.js'
)
const { loadMemoryPrompt } = await import('../../src/memdir/memdir.js')

type Row = {
  block: string
  group: string
  owner: string
  scope: string
  cacheClass: string
  chars: number
  trigger: string
}

const rows: Row[] = []

// ── 1. The system prompt (the composer's typed contract) ────────────────────
const tools = getAllBaseTools()
if (mode === 'subagent') {
  const agentPrompt = await enhanceSystemPromptWithEnvDetails(
    [DEFAULT_AGENT_PROMPT],
    model,
  )
  agentPrompt.forEach((seg, i) => {
    rows.push({
      block: i === 0 ? 'agent-prompt' : i === 1 ? 'agent-notes' : 'agent-env',
      group: 'subagent',
      owner: 'src/constants/prompts.ts',
      scope: 'all',
      cacheClass: 'session',
      chars: seg.length,
      trigger: 'spawn',
    })
  })
} else {
  await getSystemPrompt(
    tools,
    model,
    undefined,
    undefined,
    mode === 'plan' ? 'strategy' : undefined,
  )
  const provenance = readPromptProvenance()
  if (!provenance) {
    console.error('no provenance recorded — composition failed')
    process.exit(1)
  }
  for (const s of provenance.sections) {
    rows.push({
      block: s.name,
      group: s.group,
      owner: s.owner,
      scope: s.scope,
      cacheClass: s.cacheClass,
      chars: s.chars,
      trigger: s.group === 'mode' ? 'mode-engaged' : 'always',
    })
  }
}

// ── 2. Project instructions (the engine bundle — rides the first message) ───
const bundle = await getInstructionBundle()
const composition = getInstructionCompositionState()
for (const e of bundle.entries) {
  rows.push({
    block: `instructions:${e.path.split('/').slice(-2).join('/')}`,
    group: `instructions/${e.family}`,
    owner: e.path,
    scope: 'all',
    cacheClass: 'session',
    chars: e.contentLength,
    trigger: e.parent ? `@import from ${e.parent.split('/').pop()}` : e.origin,
  })
}

// ── 3. Memory prompt (memdir — the 'memory' dynamic section rides provenance
//      already in interactive mode; measured here for the subagent path) ─────
if (mode === 'subagent') {
  const memory = await loadMemoryPrompt()
  if (memory) {
    rows.push({
      block: 'memory',
      group: 'dynamic',
      owner: 'src/memdir/memdir.ts',
      scope: 'all',
      cacheClass: 'session',
      chars: memory.length,
      trigger: 'always',
    })
  }
}

const total = rows.reduce((a, r) => a + r.chars, 0)
const summary = {
  model,
  mode,
  cwd: process.cwd(),
  instructionResolution: composition.resolution,
  bundleDigest: bundle.bundleDigest.slice(0, 12),
  totalChars: total,
  estTokens: Math.round(total / 4),
  blocks: rows.length,
}

if (values.json) {
  console.log(JSON.stringify({ summary, rows }, null, 2))
} else {
  console.log(
    `# BOM · model=${model} · mode=${mode} · profile=${composition.resolution.resolved}` +
      `${composition.resolution.mapped ? ` (${composition.resolution.mapped})` : ''}`,
  )
  console.log(
    `total ${total} chars (~${summary.estTokens} tokens) across ${rows.length} blocks\n`,
  )
  const w = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))
  console.log(
    w('block', 34) + w('group', 16) + w('scope', 15) + w('cache', 9) + 'chars'.padStart(8) + '  ' + 'owner',
  )
  for (const r of rows.sort((a, b) => b.chars - a.chars)) {
    console.log(
      w(r.block, 34) + w(r.group, 16) + w(r.scope, 15) + w(r.cacheClass, 9) + String(r.chars).padStart(8) + '  ' + r.owner,
    )
  }
}
