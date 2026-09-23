import * as React from 'react'
import { basename } from 'node:path'
import type { LocalJSXCommandContext } from '../../commands.js'
import { SettingsStatusView, type StatusFact } from '../../components/mercury-ui/screens/SettingsStatusView.js'
import { AMBER, FAINT } from '../../components/mercuryPalette.js'
import { compactWorkCounts, focusedWorkRows, focusedWorkflowRows, otherSessionRunnerPids, runningWorkflowRows } from '../../components/tasks/useFocusedWork.js'
import { getMercuryDaemonStatus } from '../../daemon/status.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import { familyDisplayName } from '../../services/providers/accountSlots.js'
import { presenceIdentityWords, providerFamilyPresences, usageForProvider, usageViewIsStale } from '../../services/providers/providerUsage.js'
import { seatCeilingFacts } from '../../services/switchboard/capacityCheck.js'
import { getTelemetry } from '../../state/telemetryBus.js'
import type { AppState } from '../../state/AppState.js'
import type { LocalCommandResult } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { partitionDiskRuns } from '../../tools/WorkflowTool/runManifest.js'
import { pidAlive } from '../../utils/pidAlive.js'
import { describeArtifactIdentity } from '../../utils/artifactIdentity.js'
import { CONTEXT_FRESH_SESSION_REASON, contextGauge } from '../../utils/cockpit/contextGauge.js'
import { gitSnapshot } from '../../utils/cockpit/gitSnapshot.js'
import { healthCertSnapshot } from '../../utils/cockpit/healthCertSnapshot.js'
import { mcpGauge } from '../../utils/cockpit/mcpGauge.js'
import { modelGauge } from '../../utils/cockpit/modelGauge.js'
import { closeSettingsPopup, openSettingsPopup } from '../../utils/cockpit/settingsPopup.js'
import { getCwd } from '../../utils/cwd.js'
import type { ModelName } from '../../utils/model/model.js'
import { permissionModeTitle } from '../../utils/permissions/PermissionMode.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { resolveShellEngine } from '../../utils/shell/engineSession.js'

declare const MACRO: { VERSION: string }

const liveReads = {
  artifact: () => describeArtifactIdentity(MACRO.VERSION),
  model: modelGauge,
  context: contextGauge,
  connector: () => hasFocusedSession() ? getFocusedSessionConnector() : null,
  telemetry: getTelemetry,
  seats: seatCeilingFacts,
  settings: getInitialSettings,
  shell: resolveShellEngine,
  families: providerFamilyPresences,
  accountUsage: usageForProvider,
  health: healthCertSnapshot,
  mcp: mcpGauge,
  tasks: (): AppState['tasks'] | undefined => undefined,
  daemon: (): string => 'unavailable — not read',
}

function read<T>(owner: () => T): T | undefined {
  try { return owner() } catch { return undefined }
}

function providerAccountFacts(reads: typeof liveReads): StatusFact[] {
  const families = read(reads.families)
  const account = (id: string): string => {
    const family = families?.find(f => f.id === id)
    if (family === undefined) return 'unavailable'
    if (!family.credentialed) return 'not configured'
    const label = family.id === 'huggingface'
      ? presenceIdentityWords(family)
      : family.credentialLabel
    return label?.replace(/^OpenRouter \((.+)\)$/, '$1') ?? 'unavailable'
  }
  const usage = (id: string) => read(() => reads.accountUsage(id as Parameters<typeof usageForProvider>[0]))
  const windows = (id: string): string => {
    const view = usage(id)
    if (view === undefined) return ' · usage unavailable'
    const percentages = view.windows.filter(w => w.state === 'live' && w.usedPct !== undefined)
      .map(w => `${w.label} ${Math.round(w.usedPct!)}%${usageViewIsStale(w) ? ' stale' : ''}`)
    const meters = percentages.length > 0 ? ` · ${percentages.join(' · ')}`
      : view.shape === 'subscription-windows' ? ' · usage not read' : ''
    return meters + (view.readerNote ? ` · ${view.readerNote}` : '')
  }
  const anthropic = usage('anthropic')
  const percent = (key: string): string => {
    const window = anthropic?.windows.find(w => w.key === key)
    return window?.state === 'live' && window.usedPct !== undefined
      ? `${Math.round(window.usedPct)}%${usageViewIsStale(window) ? ' stale' : ''}`
      : 'not read'
  }
  const openai = usage('openai')
  const limited = openai?.limited
  const keyIds = ['zai', 'moonshot', 'deepseek']
  const keyValues = keyIds.map(id => account(id).replace(new RegExp(`^${familyDisplayName(id as Parameters<typeof familyDisplayName>[0]).replace('.', '\\.')} `), '') + windows(id))
  const keys = keyValues.every(value => value === keyValues[0])
    ? `Z.AI · Moonshot · DeepSeek     ${keyValues[0]!.replace(/^API key\b/, 'API keys')}`
    : keyIds.map((id, i) => `${familyDisplayName(id as Parameters<typeof familyDisplayName>[0])}  ${keyValues[i]}`).join(' · ')
  const custom = account('openai-compat') + windows('openai-compat')
  const local = account('local') + windows('local')
  return [
    { k: 'anthropic', v: `  Anthropic     ${account('anthropic')} · session ${percent('5h')} · week ${percent('7d')}` },
    {
      k: 'openai', v: `  OpenAI        ${account('openai')}`,
      note: limited
        ? ` · usage limit reached · resets ${new Date(limited.resetsAtMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace('Sept', 'Sep')}`
        : windows('openai'),
      noteTone: limited ? AMBER : undefined,
    },
    { k: 'keys', v: `  ${keys}` },
    { k: 'other-accounts', v: `  OpenRouter    ${account('openrouter')}${windows('openrouter')} · Gemini  ${account('gemini')}${windows('gemini')} · Hugging Face  ${account('huggingface')}${windows('huggingface')}` },
    { k: 'endpoints', v: custom === local ? `  Custom endpoint · Local        ${custom}` : `  Custom endpoint  ${custom} · Local  ${local}`, tone: FAINT },
  ]
}

export function buildFacts(messages: Message[], model: ModelName, overrides: Partial<typeof liveReads> = {}): {
  facts: StatusFact[]
  diagnostic: string | undefined
} {
  const reads = { ...liveReads, ...overrides }
  const connector = read(reads.connector)
  const modelFacts = read(() => connector?.modelFacts())
  const served = modelFacts?.effectiveSource !== 'ambient' ? modelFacts?.effective ?? model : model
  const modelInfo = read(() => reads.model(served))
  const usage = read(() => reads.context(messages, served))
  const context = usage?.state === 'live' && usage.data.usedPct !== null
    ? `${Math.round(usage.data.usedPct)}% of ${Math.round(usage.data.window / 1000)}k${usage.data.fillSource === 'estimate' ? ' estimated' : ''}${usage.data.windowSource === 'fallback' ? ' fallback' : ''}`
    : usage?.reason ?? 'unavailable'
  const effort = modelFacts?.effortSent === null ? 'no effort' : modelFacts?.effortSent !== undefined
    ? `${modelFacts.effortSent} effort`
    : modelFacts?.effort ? `${modelFacts.effort} effort requested` : 'effort unavailable'
  const mode = read(() => connector?.permissionMode())
  const permission = mode ? `${permissionModeTitle(mode).toLowerCase()}${mode === 'sovereign' ? ' on' : ''}` : 'permission mode unavailable'
  const telemetry = read(reads.telemetry)
  const roster = read(() => connector?.workRoster())
  const tasks = read(reads.tasks)
  const counts = telemetry && connector && roster ? read(() => compactWorkCounts({
    sessions: telemetry.sessions, focusedSessionId: connector.sessionId(), carrier: connector.carrier, roster, tasks,
  })) : undefined
  const sessions = counts?.sessionsOn
  const artifact = read(reads.artifact)
  const seats = read(reads.seats)
  const settings = read(reads.settings)
  const engineSetting = settings ? settings.shellEngine === 'brush' ? 'brush' : 'system' : undefined
  const engine = engineSetting ? read(() => reads.shell(engineSetting)) : undefined
  const shell = engineSetting === undefined || engine === undefined ? 'unavailable'
    : engineSetting === 'brush' && engine.engine !== 'brush' ? 'brush unavailable, system in use'
    : engine.engine === 'brush' ? `${engineSetting} · brush ${engine.version}` : engineSetting
  const checkpoints = read(() => connector?.checkpointFacts())
  const capture = checkpoints?.capture === 'on' ? 'capturing' : checkpoints?.capture === 'off' ? 'not capturing' : 'unavailable'
  const points = checkpoints && checkpoints.capture !== 'unknown'
    ? `${checkpoints.restorable.size} restore point${checkpoints.restorable.size === 1 ? '' : 's'}` : 'restore points unavailable'
  const health = read(reads.health)
  const cert = health?.data
  const healthWords = cert?.alert ? cert.alert.text : cert?.verdict
    ? `${cert.verdict} · ${cert.ageLabel}${cert.stale ? ' stale' : ''}`
    : health?.reason === 'no certificate issued — run /health' ? 'no cert' : health?.reason ?? 'unavailable'
  const mcp = read(reads.mcp)
  const mcpRoster = read(() => connector?.mcpRoster())
  const kitPending = modelFacts?.effectiveSource === 'record' || modelFacts?.effectiveSource === 'ambient'
  const mcpCount = connector
    ? mcpRoster && !kitPending ? String(mcpRoster.clients.length) : 'unavailable'
    : mcp && mcp.state !== 'unavailable' ? String(mcp.data.counts.total) : 'unavailable'
  const skills = kitPending ? undefined : read(() => connector?.skillsRoster())
  const rows = roster ? read(() => focusedWorkRows(tasks, roster)) : undefined
  const running = rows ? runningWorkflowRows(rows) : undefined
  const external = telemetry && rows ? read(() => {
    const known = new Set(focusedWorkflowRows(rows).map(row => row.workflowRunId ?? ''))
    const others = otherSessionRunnerPids(connector?.sessionId() ?? null)
    return partitionDiskRuns(telemetry.workflowsDisk, known, Date.now(), pidAlive).external.filter(run => !others.has(run.ownerPid))
  }) : undefined
  const workflow = roster?.reported === false || running === undefined || external === undefined ? 'unavailable'
    : running.length > 0 ? [...new Set(running.map(row => row.status))].join(' · ')
    : external.length > 0 ? external.some(run => run.liveness === 'wedged') ? 'wedged elsewhere' : 'running elsewhere' : 'idle'
  const trace = telemetry?.trace
  const traceWords = trace?.state === 'live' ? String(trace.data.total) : trace?.reason ?? 'unavailable'
  const facts: StatusFact[] = [
    { k: 'environment', v: 'Session & environment', bold: true },
    { k: 'runtime', v: `  Mercury ${artifact?.version ?? 'unavailable'} · runtime tree ${artifact?.buildTree?.slice(0, 8) ?? 'unavailable'} · daemon ${read(reads.daemon) ?? 'unavailable'} · ${sessions === null || sessions === undefined ? 'sessions on unavailable' : `${sessions} session${sessions === 1 ? '' : 's'} on`}` },
    { k: 'model', v: `  model ${modelInfo?.state === 'live' ? modelInfo.data.name : 'unavailable'} · ${effort} · context ${context} · ${permission}` },
    { k: 'settings', v: `  seats ${seats?.seats ?? 'unavailable'} · shell engine ${shell} · checkpoints ${capture} · ${points}` },
    { k: 'accounts-gap', v: '' },
    { k: 'accounts', v: 'Accounts', bold: true },
    ...providerAccountFacts(reads),
    { k: 'tools-gap', v: '' },
    { k: 'tools', v: 'Connectivity & tools', bold: true },
    { k: 'connectivity', v: `  health: ${healthWords} — /health · MCP servers ${mcpCount} — /mcp · skills ${skills?.skills.length ?? 'unavailable'} — /skills` },
    { k: 'workflow', v: `  workflow ${workflow} · trace ${traceWords} · repo` },
  ]
  const diagnostic = usage?.state !== 'live' && usage?.reason !== CONTEXT_FRESH_SESSION_REASON
    ? `Context usage ${usage?.reason ?? 'unavailable'}` : undefined
  return { facts, diagnostic }
}

export async function call(_args: string, context: LocalJSXCommandContext): Promise<LocalCommandResult> {
  const [daemon, git] = await Promise.all([
    getMercuryDaemonStatus().catch(() => undefined),
    gitSnapshot().catch(() => undefined),
  ])
  const messages = (context.messages ?? []) as Message[]
  const { facts } = buildFacts(messages, context.options.mainLoopModel, {
    daemon: () => daemon === undefined ? 'unavailable' : daemon.controlReachable ? 'running' : daemon.supervisor ? 'unreachable' : 'not running',
    tasks: () => context.getAppState?.().tasks,
  })
  const time = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  openSettingsPopup({
    view: 'status',
    width: 110,
    rows: null,
    line: `session snapshot · ${time} · ${basename(getCwd())} · ${git?.data.git?.branchName ?? git?.reason ?? 'branch unavailable'}`,
    hint: 'esc or click outside closes · /accounts · /usage · /health',
    body: g => <SettingsStatusView facts={facts} onClose={closeSettingsPopup} width={g.inner} rowBudget={g.rowBudget} />,
  })
  return { type: 'skip' }
}
