#!/usr/bin/env bun
// ============================================================================
//  scripts/behaviour-laws/capture-contracts.ts — rendered-contract capture.
//
//  Renders the REAL composed system-prompt contract for ONE posture per
//  process (mode gates read env at module load) and prints a JSON record:
//  section list (group·name·scope·chars), totals, digest, and the OpenAI
//  render for provider-boundary postures. The driver (capture-all.sh) pins
//  the environment (F6 ambient-state law: MERCURY_CONFIG_DIR + fixture cwd
//  OUTSIDE the repo) and loops the posture matrix over a tree.
//
//  Usage:  bun run scripts/behaviour-laws/capture-contracts.ts <posture>
//  The posture also selects the model and any permissionMode override.
// ============================================================================

const posture = process.argv[2]
if (!posture) {
  console.error('usage: capture-contracts.ts <posture>')
  process.exit(2)
}

;(globalThis as Record<string, unknown>)['MACRO'] = (globalThis as Record<string, unknown>)['MACRO'] ?? { VERSION: '0.0.0-capture' }

type Posture = {
  model: string
  permissionMode?: string
  headless?: boolean
  kind: 'main' | 'subagent-normal' | 'subagent-fixed'
}

const POSTURES: Record<string, Posture> = {
  'fable-default': { model: 'claude-fable-5', kind: 'main' },
  'opus-default': { model: 'claude-opus-4-8', kind: 'main' },
  'sonnet-default': { model: 'claude-sonnet-5', kind: 'main' },
  gpt: { model: 'gpt-5.6-codex', kind: 'main' },
  autopilot: { model: 'claude-fable-5', permissionMode: 'autopilot', kind: 'main' },
  headless: { model: 'claude-fable-5', headless: true, kind: 'main' },
  'subagent-normal': { model: 'claude-sonnet-5', kind: 'subagent-normal' },
  'subagent-fixed': { model: 'claude-sonnet-5', kind: 'subagent-fixed' },
}

const spec = POSTURES[posture]
if (!spec) {
  console.error(`unknown posture '${posture}' — one of: ${Object.keys(POSTURES).join(' ')}`)
  process.exit(2)
}

async function main(): Promise<void> {
  if (spec.headless) {
    const bootstrap = await import('../../src/bootstrap/state.js')
    const set = (bootstrap as Record<string, unknown>)['setIsNonInteractiveSession']
    if (typeof set === 'function') (set as (v: boolean) => void)(true)
  }

  const prompts = await import('../../src/constants/prompts.js')
  const contractMod = await import('../../src/prompt/behaviourContract.js')

  const toolNames = [
    'Bash', 'Glob', 'Grep', 'Read', 'Edit', 'Write', 'NotebookEdit',
    'WebFetch', 'WebSearch', 'Agent', 'Skill', 'TaskCreate', 'TaskUpdate',
    'TaskList', 'TaskGet', 'AskUserQuestion', 'ToolSearch',
  ]
  const tools = toolNames.map(name => ({ name })) as never

  let segments: string[]
  if (spec.kind === 'main') {
    segments = await prompts.getSystemPrompt(
      tools,
      spec.model,
      undefined,
      [],
      spec.permissionMode as never,
      undefined,
    )
  } else {
    const doctrine = await import('../../src/constants/subagentDoctrine.js')
    const { VERIFICATION_AGENT } = await import('../../src/tools/AgentTool/built-in/verificationAgent.js')
    const agentDefinition =
      spec.kind === 'subagent-fixed'
        ? VERIFICATION_AGENT
        : ({ agentType: 'general-purpose' } as never)
    const agentPrompt =
      spec.kind === 'subagent-fixed'
        ? (VERIFICATION_AGENT as { getSystemPrompt?: (a: unknown) => string }).getSystemPrompt?.({ toolUseContext: { options: {} } }) ?? prompts.DEFAULT_AGENT_PROMPT
        : prompts.DEFAULT_AGENT_PROMPT
    segments = await prompts.enhanceSystemPromptWithEnvDetails(
      [
        ...doctrine.buildSubagentMercurySections({
          agentDefinition: agentDefinition as never,
          toolUseContext: { options: {} } as never,
          childModel: spec.model,
        }),
        agentPrompt,
      ],
      spec.model,
      undefined,
      new Set(toolNames),
    )
  }

  const contract = contractMod.resolveBehaviourContract(segments)
  const openai = contractMod.renderOpenaiInstructions(contract)
  const anthropicChars = segments.reduce((a, s) => a + s.length, 0)

  const claudeMarkers = (text: string): number =>
    (text.match(/\bClaude\b|claude-|Anthropic/g) ?? []).length

  const record = {
    posture,
    model: spec.model,
    segmentCount: segments.length,
    totalChars: anthropicChars,
    digest: contract.digest,
    openaiChars: openai.length,
    openaiClaudeMarkers: claudeMarkers(openai),
    sections: contract.sections.map(s => ({
      group: s.group,
      name: s.name,
      scope: s.scope,
      chars: s.text.length,
    })),
    // full text retained for offline duplication/stale-name analysis
    texts: contract.sections.map(s => s.text),
  }
  console.log(JSON.stringify(record))
}

main().catch(err => {
  console.error(`[capture:${posture}] ${err?.stack ?? err}`)
  process.exit(1)
})
