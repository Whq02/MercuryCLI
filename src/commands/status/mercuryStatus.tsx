import * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import {
  SettingsStatusView,
  type StatusFact,
  type StatusMcp,
} from '../../components/mercury-ui/screens/SettingsStatusView.js'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../components/mercuryPalette.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import type { Message } from '../../types/message.js'
import type { ModelName } from '../../utils/model/model.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getCwd } from '../../utils/cwd.js'
import { concourseWayBack, plainWorldWhy } from '../../context/surfaceRoute.js'
import { recordingsUnderSweep, retentionWindowDays } from '../../utils/cleanup.js'
import { formatFileSize, formatRelativeTimeAgo } from '../../utils/format.js'
import { getCurrentSessionTitle, transcriptCensus } from '../../utils/sessionStorage.js'
import { familyDisplayName } from '../../services/providers/accountSlots.js'
import { providerFamilyPresences } from '../../services/providers/providerUsage.js'
import { getAccountInformation } from '../../utils/auth.js'
import { activeWalletEntry, walletEntries } from '../../services/wallet/wallet.js'
import { CONTEXT_FRESH_SESSION_REASON, contextGauge } from '../../utils/cockpit/contextGauge.js'
import { mcpCountsLabel, mcpGauge } from '../../utils/cockpit/mcpGauge.js'
import { modelGauge } from '../../utils/cockpit/modelGauge.js'

declare const MACRO: { VERSION: string }

function providerAccountFacts(): StatusFact[] {
  const isDemo = Boolean(process.env.IS_DEMO)
  const allEntries = walletEntries()
  return providerFamilyPresences().map(family => {
    const entries = allEntries.filter(e => e.provider === family.id)
    const active = entries.length > 0 ? activeWalletEntry(entries[0]!.provider) : undefined
    const label = family.credentialLabel ?? active?.label
    const orgNote =
      family.id === 'anthropic' && label && !isDemo
        ? getAccountInformation()?.organization
        : undefined
    return {
      k: familyDisplayName(family.id),
      v: label ?? 'not logged in',
      tone: label ? IVORY : FAINT,
      note: label ? (orgNote ? `· ${orgNote}` : undefined) : '· /logins connects',
    }
  })
}

function worldFact(): StatusFact {
  const why = plainWorldWhy()
  if (why === null) return { k: 'Concourse', v: 'on', tone: TEAL, note: '· the fleet world' }
  return { k: 'Concourse', v: `off this boot (${why})`, tone: SECOND, note: `· the plain world — ${concourseWayBack()}` }
}

function shortId(id: string): string {
  if (id.length <= 20) return id
  return `${id.slice(0, 8)}…${id.slice(-12)}`
}

export function buildFacts(messages: Message[], model: ModelName): {
  facts: StatusFact[]
  diagnostic: string | undefined
} {
  const modelInfo = modelGauge(model).data
  const usage = contextGauge(messages, model)
  const sessionId: ReturnType<typeof getSessionId> | undefined = getSessionId()
  const title = sessionId ? getCurrentSessionTitle(sessionId) : undefined

  let ctxFact: StatusFact
  if (usage.state === 'live' && usage.data.usedPct != null) {
    ctxFact = {
      k: 'Context',
      v: `${Math.round(usage.data.usedPct)}% used`,
      tone: usage.data.usedPct >= 80 ? AMBER : TEAL,
      note: usage.data.window ? `· ${Math.round(usage.data.window / 1000)}k window` : undefined,
    }
  } else {
    ctxFact = {
      k: 'Context',
      v: usage.reason ?? 'unavailable',
      tone: FAINT,
    }
  }

  const facts: StatusFact[] = [
    { k: 'Version', v: MACRO.VERSION, note: '· standalone source build' },
    {
      k: 'Session',
      v: title ?? 'unnamed',
      tone: title ? SECOND : FAINT,
      note: title ? undefined : '· /rename to add a name',
    },
    { k: 'Session ID', v: sessionId ? shortId(sessionId) : 'not yet assigned', tone: FAINT },
    { k: 'cwd', v: getCwd(), tone: SECOND },
    worldFact(),
    ...providerAccountFacts(),
    {
      k: 'Model',
      v: modelInfo.name,
      tone: modelInfo.window ? IVORY : FAINT,
      note: modelInfo.window ? `· ${Math.round(modelInfo.window / 1000)}k context` : undefined,
    },
    ctxFact,
  ]

  const diagnostic =
    usage.state !== 'live' && usage.reason !== CONTEXT_FRESH_SESSION_REASON
      ? `Context usage ${usage.reason ?? 'unavailable'}`
      : modelInfo.window
        ? undefined
        : 'Model context window unavailable'

  return { facts, diagnostic }
}

type RetentionNumbers = {
  transcripts: { count: number; bytes: number; oldestMtimeMs: number | null } | null
  recordings: { count: number; bytes: number } | null
  windowDays: number
}

async function readRetentionNumbers(): Promise<RetentionNumbers> {
  const windowDays = retentionWindowDays()
  let transcripts: RetentionNumbers['transcripts'] = null
  try {
    transcripts = await transcriptCensus()
  } catch {
    transcripts = null
  }
  let recordings: RetentionNumbers['recordings'] = null
  try {
    recordings = await recordingsUnderSweep()
  } catch {
    recordings = null
  }
  return { transcripts, recordings, windowDays }
}

function retentionFacts(r: RetentionNumbers): StatusFact[] {
  const transcriptsFact: StatusFact = r.transcripts === null
    ? { k: 'Transcripts', v: 'unavailable', tone: FAINT }
    : r.transcripts.count === 0
      ? { k: 'Transcripts', v: 'none yet', tone: FAINT, note: '· kept for good once made' }
      : {
          k: 'Transcripts',
          v: `${r.transcripts.count} kept for good`,
          tone: IVORY,
          note: `· ${formatFileSize(r.transcripts.bytes)}${
            r.transcripts.oldestMtimeMs === null
              ? ''
              : ` · oldest ${formatRelativeTimeAgo(new Date(r.transcripts.oldestMtimeMs), { style: 'short' })}`
          }`,
        }
  const recordingsFact: StatusFact = r.recordings === null
    ? { k: 'Recordings', v: 'unavailable', tone: FAINT }
    : r.recordings.count === 0
      ? { k: 'Recordings', v: 'none aging', tone: FAINT, note: `· .cast only · ${r.windowDays}-day window` }
      : {
          k: 'Recordings',
          v: `${r.recordings.count} aging (.cast)`,
          tone: SECOND,
          note: `· ${formatFileSize(r.recordings.bytes)} · swept after ${r.windowDays} days`,
        }
  return [transcriptsFact, recordingsFact]
}

function buildMcp(): StatusMcp[] {
  const snap = mcpGauge()
  if (snap.state !== 'live' || snap.data.names.length === 0) return []
  const c = snap.data.counts
  const splitTone = c.failed > 0 ? CRIMSON : c.needsAuth > 0 || c.starting > 0 ? AMBER : TEAL
  const riskTone = snap.data.mcpPolicyActive ? TEAL : AMBER
  return [
    { tone: splitTone, count: '', label: mcpCountsLabel(c) },
    { tone: riskTone, count: '', label: `max risk ${snap.data.mcpPolicyHint}` },
  ]
}

function MercuryStatusWrapper({
  messages,
  model,
  retention,
  onDone,
}: {
  messages: Message[]
  model: ModelName
  retention: StatusFact[]
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const { facts, diagnostic } = buildFacts(messages, model)
  const mcp = buildMcp()
  return (
    <SettingsStatusView
      facts={facts}
      retention={retention}
      mcp={mcp}
      diagnostic={diagnostic}
      onClose={(value?: unknown, options?: Parameters<typeof onDone>[1]) => { const v = typeof value === 'string' ? value : undefined; onDone(v, options ?? (v === undefined ? { display: 'skip' } : undefined)) }}
    />
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  if (args && args.trim()) {
    const base = await import('./status.js')
    return base.call(onDone, context)
  }
  const messages = (context.messages ?? []) as Message[]
  const model = getMainLoopModel()
  const retention = retentionFacts(await readRetentionNumbers())
  return <MercuryStatusWrapper messages={messages} model={model} retention={retention} onDone={onDone} />
}
