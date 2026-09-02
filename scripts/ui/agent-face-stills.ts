#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'agent-face')

const scratchHome = mkdtempSync(join(tmpdir(), 'agent-face-stills-'))
process.env['MERCURY_CONFIG_DIR'] = scratchHome
process.env['FORCE_COLOR'] = '0'
process.env['MERCURY_CRITTER_GAZE'] = '0'
process.env['MERCURY_LIVE_GLYPHS'] = '0'

const FIXTURE_AGENT_RAW = [
  '---',
  'name: fixture-scout',
  'description: Use this agent to scout the fixture estate when frames need every field painted.',
  'tools: Read, Grep',
  'disallowedTools: Bash',
  'skills: chart-lore, map-lore',
  'model: opus',
  'effort: high',
  'permissionMode: default',
  'maxTurns: 12',
  'memory: project',
  'background: true',
  'isolation: worktree',
  'initialPrompt: Survey the estate first.',
  'instructionProfile: native',
  'color: teal',
  '---',
  'You are the fixture scout. Walk the estate, name what stands, and report',
  'in the estate\'s own vocabulary. Never invent rooms the map does not show.',
  '',
].join('\n')

function normalize(frame: string): string {
  return frame
    .replace(/(?:\/[\w.-]+){2,}\/?…?/g, '<PATH>')
    .replace(/<PATH>.?…/g, '<PATH>')
    .replace(/[ \t]+$/gm, '')
}

async function captureInchatFrames(): Promise<Record<string, string>> {
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
  enableConfigs()
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { StudioEditor } = await import('../../src/components/agents/studio/StudioEditor.js')

  const cwd = mkdtempSync(join(tmpdir(), 'agent-face-cwd-'))
  const agentDir = join(cwd, '.mercury', 'agents')
  mkdirSync(agentDir, { recursive: true })
  const agentPath = join(agentDir, 'fixture-scout.md')
  writeFileSync(agentPath, FIXTURE_AGENT_RAW)

  const { decodeAgentDocument } = await import('../../src/services/agents/codec.js')
  const { revisionDigest } = await import('../../src/services/agents/contracts.js')
  const doc = decodeAgentDocument(FIXTURE_AGENT_RAW, agentPath)
  const fixtureDefinition = {
    agentType: 'fixture-scout',
    whenToUse: doc.fields.description,
    getSystemPrompt: () => doc.body,
    source: 'projectSettings',
    filePath: agentPath,
    revision: revisionDigest(FIXTURE_AGENT_RAW),
  } as never

  const shared = {
    cwd,
    tools: [] as never,
    existingAgents: [fixtureDefinition] as never,
    parentModel: 'claude-fable-5' as never,
    sessionEffort: undefined,
    onSaved: () => {},
    onCancel: () => {},
  }

  const frames: Record<string, string> = {}
  frames['inchat-create-guided'] = normalize(
    await renderToString(React.createElement(StudioEditor, { mode: 'create', ...shared, cwd: '/repo' } as never), 100),
  )
  frames['inchat-edit-advanced'] = normalize(
    await renderToString(
      React.createElement(StudioEditor, {
        mode: 'edit',
        base: { identity: { filePath: agentPath, revision: revisionDigest(FIXTURE_AGENT_RAW) }, agent: fixtureDefinition },
        ...shared,
      } as never),
      100,
    ),
  )
  return frames
}

async function captureFaceFrames(): Promise<Record<string, string>> {
  const { createSplashCore } = await import('../../assets/splash/splash-core.mjs')
  const {
    AGENT_FACE_LEGEND,
    AGENT_FACE_LEGEND_FORM,
    agentFaceDetailLines,
    agentFaceEntryOf,
    agentFaceStatusLine,
    agentFaceSummaryRows,
    agentFormDetailLines,
    agentFormEntryOf,
    agentFormRowIds,
  } = await import('../../src/components/BootAgentsScreen.js')
  const { buildStudioRows } = await import('../../src/components/agents/studio/studioData.js')
  const { computeStudioValidation, createStudioEditorMachine, studioDestinationPath } = await import(
    '../../src/components/agents/studio/studioEditorModel.js'
  )
  const core = createSplashCore({ nocolor: true, truecolor: false }) as {
    composeBootMenu: (cols: number, rows: number, m: unknown) => { lines: string[] }
  }

  const mk = (over: Record<string, unknown>): AgentFixtureDef =>
    ({
      agentType: 'x',
      whenToUse: 'x',
      getSystemPrompt: () => 'You are a fixture.',
      source: 'projectSettings',
      ...over,
    }) as AgentFixtureDef
  type AgentFixtureDef = import('../../src/tools/AgentTool/loadAgentsDir.js').AgentDefinition
  const scout = mk({
    agentType: 'fixture-scout',
    whenToUse: 'Use this agent to scout the fixture estate when frames need every field painted.',
    filePath: '/repo/.mercury/agents/fixture-scout.md',
    revision: 'rev-1',
    model: 'opus',
  })
  const keeper = mk({
    agentType: 'ledger-keeper',
    whenToUse: 'Use this agent to keep the fixture ledger square.',
    source: 'userSettings',
    filePath: '/home/.mercury/agents/ledger-keeper.md',
    revision: 'rev-2',
    disabled: true,
  })
  const builtin = mk({
    agentType: 'general-purpose',
    whenToUse: 'General-purpose fixture for researching complex questions.',
    source: 'built-in',
  })
  const result = {
    activeAgents: [scout, builtin],
    allAgents: [scout, keeper, builtin],
  } as import('../../src/tools/AgentTool/loadAgentsDir.js').AgentDefinitionsResult
  const built = buildStudioRows(result, { tab: 'all', filter: 'all', query: '' })
  const counts = { active: 2, disabled: 1, issues: 0 }
  const environment = { model: 'fable', critter: 'Crab', critterHue: '#DD4444', dirBase: 'hermes', dirTail: '' }
  const libraryM = {
    title: 'agents',
    summaryTitle: 'AGENTS',
    summaryRows: agentFaceSummaryRows(counts),
    environment,
    entries: built.rows.map(agentFaceEntryOf),
    selIdx: 0,
    statusRight: agentFaceStatusLine(counts),
    legend: AGENT_FACE_LEGEND,
    detailOverride: agentFaceDetailLines(built.rows[0]!, built.estate, null),
    glowWord: null,
  }

  const machine = createStudioEditorMachine(
    {
      mode: 'create',
      cwd: '/repo',
      getExistingAgents: () => result.allAgents,
      getParentModel: () => 'claude-fable-5',
      onSaved: () => {},
      onCancel: () => {},
    },
    () => {},
    {
      readFile: () => {
        throw new Error('no files in the still world')
      },
      listDrafts: () => [],
      saveDraft: async () => '/dev/null',
      discardDraft: () => {},
      saveDocument: async () => {
        throw new Error('never saved in a still')
      },
      generate: async () => {
        throw new Error('never generated in a still')
      },
      setTimer: () => 0,
      clearTimer: () => {},
    },
  )
  machine.setView({ kind: 'advanced', cursor: 0, editing: null })
  machine.commit({ set: { name: 'draft-scout' } })
  machine.commit({ set: { description: 'Use this agent when the frame needs a mid-create draft.' } })
  const snap = machine.snapshot()
  const validation = computeStudioValidation({ doc: snap.doc, existingAgents: [], base: undefined, mode: 'create' })
  const formM = {
    title: 'agents',
    summaryTitle: 'AGENTS',
    summaryRows: agentFaceSummaryRows(counts),
    environment,
    entries: agentFormRowIds('create').map(id => agentFormEntryOf(id, snap)),
    selIdx: 0,
    statusRight: 'the agent form — ↵ edits a row · s saves',
    legend: AGENT_FACE_LEGEND_FORM,
    detailOverride: agentFormDetailLines({
      snap,
      validation,
      destination: studioDestinationPath({ base: undefined, scope: snap.scope, cwd: '/repo', name: snap.doc.fields.name }),
      effectiveLine: 'inherit · effort session',
      mode: 'create',
    }),
    glowWord: null,
  }
  machine.dispose()

  const { getAgentModelPickerRows } = await import('../../src/utils/model/agentModelPicker.js')
  const fixtureCatalogue = [
    { value: 'fable', label: 'Fable', description: '' },
    { value: 'gpt-6.2', label: 'GPT-6.2', description: '', group: 'Mercury — OpenAI models', unavailable: 'no OpenAI account connected' },
    { value: '__mercury_connect__:zai', label: 'Z.AI — attach a key', description: '↵ opens the sign-in door', group: 'Mercury — Z.AI models' },
    { value: 'glm-5.3', label: 'GLM-5.3', description: '', group: 'Mercury — Z.AI models', unavailable: 'no API key attached' },
    { value: 'compat/qwen3', label: 'qwen3', description: '', group: 'Mercury — custom endpoint' },
  ] as never
  const modelRows = getAgentModelPickerRows(fixtureCatalogue)
  const pickM = {
    title: 'agents',
    summaryTitle: 'AGENTS',
    summaryRows: agentFaceSummaryRows(counts),
    environment,
    entries: modelRows.map(r => ({
      label: r.kind === 'connect' ? `${r.label} …` : r.label,
      group: r.group,
      groupTitle: r.group,
      summary: r.unavailable ?? r.description,
      valueLabel: r.kind === 'connect' ? 'sign in' : r.unavailable !== undefined ? 'needs sign-in' : 'inherit' === r.value ? 'current' : '',
      valueIsDefault: r.unavailable === undefined && r.kind !== 'connect',
      pinnedVal: null,
      detail: null,
    })),
    selIdx: 0,
    statusRight: `${modelRows.length} rows — the full catalogue; ↵ on a sign-in row opens Logins`,
    legend: '↑↓ move · ↵ pick · esc back',
    glowWord: null,
  }

  return {
    'face-library-120x40': core.composeBootMenu(120, 40, libraryM).lines.join('\n'),
    'face-library-64x12': core.composeBootMenu(64, 12, libraryM).lines.join('\n'),
    'face-form-120x40': core.composeBootMenu(120, 40, formM).lines.join('\n'),
    'face-model-pick-120x40': core.composeBootMenu(120, 40, pickM).lines.join('\n'),
  }
}

const write = process.argv.includes('--write')
const frames = { ...(await captureInchatFrames()), ...(await captureFaceFrames()) }
let failed = 0
mkdirSync(FIXTURES, { recursive: true })
for (const [name, frame] of Object.entries(frames)) {
  const path = join(FIXTURES, `${name}.txt`)
  if (write) {
    writeFileSync(path, frame)
    console.log(`wrote ${name} (${frame.split('\n').length} lines)`)
  } else {
    let expected: string | null = null
    try {
      expected = readFileSync(path, 'utf-8')
    } catch {
      expected = null
    }
    const ok = expected !== null && expected === frame
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
    if (!ok) failed += 1
  }
}
if (!write && failed > 0) {
  console.error(`${failed} still(s) drifted — regen on purpose via --write`)
  process.exit(1)
}
