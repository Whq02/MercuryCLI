import { getMnemeHome } from '../../../sessions/mneme/paths.js'
import { isAwaySummaryEnabled } from '../../../screen/cockpit/awaySummary.js'
import { isMercuryCompactKeepTailEnabled } from '../../../engine/compaction/verbatimTail.js'
import { getEngineModel } from '../../../models/catalogue/engineModel.js'
import { contextWindowLabel } from '../../../engine/context-window/contextFill.js'
import { isLocalModelId } from '../../../models/roads/local/localCatalogue.js'
import { getLiveContextUsage } from '../../../screen/cockpit-gauges/contextUsageLive.js'
import { ctxForecastEnabled } from '../../../screen/cockpit-gauges/ctxForecast.js'
import { healthFixEnabled } from '../healthFix.js'
import type { CheckSpec } from '../healthReport.js'

export function memoryChecks(): CheckSpec[] {
  return [
    {
      id: 'memory',
      label: 'Memory front page',
      run: async () => {
        const { mnemeEnabled, mnemeLibraryDir } = await import('../../../sessions/mneme/mnemeGates.js')
        if (!mnemeEnabled()) {
          return { status: 'off', evidence: 'memory is off (memory.enabled is false in settings) — nothing is loaded or saved' }
        }
        const { pinnedStatusPath, readFrontPage, readPinnedStatus } = await import('../../../sessions/mneme/mnemeFrontPage.js')
        const { formatTextSize } = await import('../../../sessions/mneme/mnemeUsage.js')
        const { handoverReceiptPath, readHandoverReceipt } = await import('../../../sessions/mneme/mnemeHandover.js')
        const { mnemeUnreadSentence } = await import('../../../sessions/mneme/mnemeUnread.js')
        const dir = mnemeLibraryDir()
        const page = readFrontPage(dir)
        if (page === null) {
          return { status: 'info', evidence: `no front page yet under ${getMnemeHome()} — it is written at the first consolidation` }
        }
        const pinned = readPinnedStatus(dir)
        const topics = page.split('\n').filter(l => /^- /.test(l) && !/ <seq=/.test(l)).length
        const intake = readHandoverReceipt(dir)
        const unread = mnemeUnreadSentence([pinnedStatusPath(dir), handoverReceiptPath(dir)])
        if (unread !== null) {
          const pinnedPart = pinned ? ` · pinned ${pinned.pinned} rule(s) ${formatTextSize(pinned.used)} of ${formatTextSize(pinned.limit)}` : ''
          const intakePart = intake ? ` · intake ${intake.notes} note(s) → ${intake.facts} fact(s)` : ''
          return {
            status: 'warn',
            evidence: `front page ${formatTextSize(page.length)} · ${topics} topic line(s)${pinnedPart}${intakePart} · ${unread}`,
            link: '/memory',
          }
        }
        const evidence = `front page ${formatTextSize(page.length)} · ${topics} topic line(s) · pinned ${pinned?.pinned ?? 0} rule(s) ${pinned ? `${formatTextSize(pinned.used)} of ${formatTextSize(pinned.limit)}` : ''}${intake ? ` · intake ${intake.notes} note(s) → ${intake.facts} fact(s)` : ''}`
        if (pinned?.over) {
          return {
            status: 'warn',
            evidence,
            fix: 'The pinned rules fill more than the limit — every rule still loads. Unpin in /memory (u on a rule) or raise the limit in /config.',
            link: '/memory',
          }
        }
        return { status: 'ok', evidence }
      },
    },
    {
      id: 'memory-verbs',
      label: 'Memory verbs',
      run: async () => {
        const { memoryVerbsEnabled, memoryVerbsWhyNot } = await import('../../../sessions/mneme/memoryVerbs.js')
        const { mnemeStatus } = await import('../../../sessions/mneme/mnemeMaintenance.js')
        if (!memoryVerbsEnabled()) {
          return {
            status: 'off',
            evidence: `Retain/Recall/Reflect/Correct absent — ${memoryVerbsWhyNot() ?? 'unknown'}`,
          }
        }
        const status = mnemeStatus()
        return {
          status: 'ok',
          evidence: `Retain/Recall/Reflect/Correct live · buffer ${status.buffered} · ${status.topicCount} topic page(s) · ${status.entryCount} fact(s)`,
        }
      },
    },
    {
      id: 'memory-embedder',
      label: 'Semantic embedder',
      run: async () => {
        const { mnemeEnabled } = await import('../../../sessions/mneme/mnemeGates.js')
        const { describeSemanticReadiness, memoryRecallModeWords } = await import('../../../sessions/mneme/embedModels.js')
        const ready = describeSemanticReadiness()
        const pack = ready.state === 'ok'
          ? `present: ${ready.model} (${ready.dimension} dimensions)`
          : `degraded: ${ready.words} (${ready.note})`
        if (!mnemeEnabled()) {
          return { status: 'off', evidence: `memory is off (memory.enabled is false in settings); the embedder pack is ${pack}` }
        }
        const evidence = `${pack} · Recall ranks by ${memoryRecallModeWords()}`
        if (ready.state === 'ok') return { status: 'ok', evidence }
        return { status: 'info', evidence, link: '/memory' }
      },
    },
    {
      id: 'context',
      label: 'Context & resume',
      run: async () => {
        const { compactionSettingsText } = await import('../../../engine/compaction/autoFold.js')
        const usage = getLiveContextUsage()
        const arms = [
          compactionSettingsText(),
          `keep-tail ${isMercuryCompactKeepTailEnabled() ? 'on' : 'off'}`,
          `away-summary ${isAwaySummaryEnabled() ? 'on' : 'off'}`,
          `forecast ${ctxForecastEnabled() ? 'on' : 'off'}`,
        ].join(' · ')
        if (usage.usedPct === null) {
          return {
            status: 'info',
            evidence: `no context sample published yet this session · resume arms: ${arms}`,
          }
        }
        const compactAt = usage.compactAtPct
        const { focusedSessionModelFacts } = await import('../../../engine/connector/focusedConnector.js')
        const window = isLocalModelId(focusedSessionModelFacts()?.effective ?? getEngineModel()) && usage.window > 0 ? contextWindowLabel(usage.window, null, false, true) : `${Math.round(usage.window / 1000)}k`
        const evidence = `context ${usage.usedPct.toFixed(0)}% of ${window}${compactAt !== null ? ` · autocompact at ${compactAt}%` : ''} · ${arms}`
        if (compactAt !== null && usage.usedPct >= compactAt - 5) {
          return {
            status: 'warn',
            evidence,
            fix: 'Autocompact is imminent — bank anything load-bearing (todo/memory) before the squeeze.',
          }
        }
        return { status: 'ok', evidence }
      },
    },
    {
      id: 'preserved-thinking',
      label: 'Preserved thinking',
      run: async () => {
        const { preservedThinkingHealth, readThinkingDropLedgerStrict, forgetThinkingDropLedger } = await import(
          '../../../models/roads/anthropic/thinkingBinding.js'
        )
        const ledger = readThinkingDropLedgerStrict()
        const row = preservedThinkingHealth(ledger)
        if (ledger === null || row.status !== 'warn' || !healthFixEnabled()) return row
        return {
          ...row,
          remedy: {
            plan: 'forget the recorded thinking drop (derived evidence under the config home; a new drop is recorded again)',
            class: 'safe' as const,
            apply: async () => (forgetThinkingDropLedger() ? { ok: true, note: 'the record was removed' } : { ok: false, note: 'the record could not be removed' }),
            verify: async () => (readThinkingDropLedgerStrict() === null ? { ok: true, note: 'no dropped thinking block recorded' } : { ok: false, note: 'the record still stands' }),
          },
        }
      },
    },
  ]
}
