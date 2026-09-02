// mercuryStatus — Mercury's /status surface: the Mercury warm-ink Settings·Status
// view (SettingsStatusView) wired to REAL session/env/model/MCP data from the
// cockpit snapshot layer + the base status helpers. No fabricated values — every
// row is a live read, and a read with no source shows its honest note instead.
// Falls back to the base status.tsx for any arg path so default behaviour is preserved.
//
// Mirrors commands/model/mercuryModel.tsx: a hand-written (NOT React-Compiler)
// wrapper component + the LocalJSXCommandCall export; the index flag-gates which
// module loads (Mercury view unconditionally).
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
import { presenceIdentityWords, providerFamilyPresences } from '../../services/providers/providerUsage.js'
import { getAccountInformation } from '../../utils/auth.js'
import { activeWalletEntry, walletEntries } from '../../services/wallet/wallet.js'
import { CONTEXT_FRESH_SESSION_REASON, contextGauge } from '../../utils/cockpit/contextGauge.js'
import { mcpCountsLabel, mcpGauge } from '../../utils/cockpit/mcpGauge.js'
import { modelGauge } from '../../utils/cockpit/modelGauge.js'

// MACRO.VERSION is folded at build (the Mercury version string). Declared
// here so this hand-written module type-checks against the build define.
declare const MACRO: { VERSION: string }

// Provider-NEUTRAL account facts: one row
// per registry family, derived — never a hand-kept provider pair. (The old
// accountFact() helper filtered for string-valued properties, but the
// account builders emit <Text> nodes — the Claude row read 'not signed in'
// on every signed-in boot. The wallet/presence reads below are the truth.)
function providerAccountFacts(): StatusFact[] {
  const isDemo = Boolean(process.env.IS_DEMO)
  const allEntries = walletEntries()
  return providerFamilyPresences().map(family => {
    const entries = allEntries.filter(e => e.provider === family.id)
    const active = entries.length > 0 ? activeWalletEntry(entries[0]!.provider) : undefined
    // The ONE identity composer's words (the sign-in's email over the plan
    // label); the demo environment keeps the non-identifying label.
    const label = (isDemo ? family.credentialLabel : presenceIdentityWords(family)) ?? active?.label
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

// THE WORLD (the chat-mode law): which world this boot is in and why — the
// fleet world (the concourse on), or the plain world by the `--chat` mark,
// the saved switch, or both — with the way back in the router's own words
// (one owner: surfaceRoute). The receipt for `--chat` beside `--concourse-on`
// reads here: this boot plain by the mark, the switch on for the next.
function worldFact(): StatusFact {
  const why = plainWorldWhy()
  if (why === null) return { k: 'Concourse', v: 'on', tone: TEAL, note: '· the fleet world' }
  return { k: 'Concourse', v: `off this boot (${why})`, tone: SECOND, note: `· the plain world — ${concourseWayBack()}` }
}

// Truncate a long id to a head…tail form for the dense status row.
function shortId(id: string): string {
  if (id.length <= 20) return id
  return `${id.slice(0, 8)}…${id.slice(-12)}`
}

// Build the REAL session/environment facts from the gauge owners + the base
// helpers. Every value is a live read; an unavailable read renders its honest
// note.
// Exported for the fresh-session banner prover (FC-139).
export function buildFacts(messages: Message[], model: ModelName): {
  facts: StatusFact[]
  diagnostic: string | undefined
} {
  // The two owners this view paints: the model line (label + window with
  // provenance) and the context fill (the one derivation the trigger reads).
  const modelInfo = modelGauge(model).data
  const usage = contextGauge(messages, model)
  // The identity owner can momentarily hold no id at an early render (the
  // declared type says otherwise — live-crashed driving /status
  // in a capture: shortId(undefined) read .length). Honest fallback, never
  // a render error.
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
    // Provider-labeled accounts: one row per registry family, derived —
    // every connected account shows with its provider, an absent provider
    // shows the honest /logins row (multi-auth is the norm; no structural
    // favourite).
    ...providerAccountFacts(),
    {
      k: 'Model',
      v: modelInfo.name,
      tone: modelInfo.window ? IVORY : FAINT,
      note: modelInfo.window ? `· ${Math.round(modelInfo.window / 1000)}k context` : undefined,
    },
    ctxFact,
  ]

  // Honest diagnostic: surface a real degraded read, else nothing (✓ shown).
  // FC-139: the gauge's documented fresh-session state is NORMAL — the
  // fact already renders neutrally in the Context row two rows above, and
  // a warn banner about it contradicted the gauge's own header. Only a
  // genuinely degraded read raises the banner.
  const diagnostic =
    usage.state !== 'live' && usage.reason !== CONTEXT_FRESH_SESSION_REASON
      ? `Context usage ${usage.reason ?? 'unavailable'}`
      : modelInfo.window
        ? undefined
        : 'Model context window unavailable'

  return { facts, diagnostic }
}

// THE RETENTION BLOCK (the operator's L11 later parcel): the retention
// promise in real numbers, read from the estate's own owners — the
// transcript census from the session store's enumerator
// (sessionStorage/logs.ts), the recordings census and the window from the
// sweep's own file (utils/cleanup.ts) — never a second counter here.
// Transcripts are "kept for good" (the law's words): the sweep ages only
// recordings (.cast); the one deleting act is the operator's own, behind
// the /sessions prune door. The estate exposes no rebuildable-state
// budget, so no such row paints (an absent owner is never invented).
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

// Real MCP facts from the ONE MCP owner (configured rows joined with this
// process's connections). `off` when none configured (a valid state). The
// rows stay honest: the per-state count split (the gauge's one-line counts
// label — operator-ruled) + the policy's max exposed tool-risk.
function buildMcp(): StatusMcp[] {
  const snap = mcpGauge()
  if (snap.state !== 'live' || snap.data.names.length === 0) return []
  // Tone the split by the worst state present: any failure paints crimson,
  // a needs-auth/connecting set paints amber, an all-ready set teal.
  const c = snap.data.counts
  const splitTone = c.failed > 0 ? CRIMSON : c.needsAuth > 0 || c.starting > 0 ? AMBER : TEAL
  // Tone the risk row by whether the policy is ACTIVE (per-server overrides
  // included), not by the bare-default risk word: a clamp leaves maxRisk='high'
  // yet the gate enforces, so `=== 'high'` would wrongly paint AMBER 'permissive'.
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
  // Any arg path → the base Settings·Status .
  if (args && args.trim()) {
    const base = await import('./status.js')
    return base.call(onDone, context)
  }
  const messages = (context.messages ?? []) as Message[]
  const model = getMainLoopModel()
  // The retention numbers are read once, before mount — two stat walks over
  // the projects store (the same cost /resume pays on open); a failed read
  // paints its honest 'unavailable' row, never a fabricated number.
  const retention = retentionFacts(await readRetentionNumbers())
  return <MercuryStatusWrapper messages={messages} model={model} retention={retention} onDone={onDone} />
}
