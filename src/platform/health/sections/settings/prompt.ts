import { getCwd } from '../../../files/cwd.js'
import { getInstructionBundle, getInstructionCompositionState } from '../../../../sessions/instructions/instructionFiles.js'
import { sharedSourcesNote } from '../../../../sessions/instructions/listing.js'
import { readPromptProvenance } from '../../../../screen/cockpit/promptProvenance.js'
import { getSettingsWithAllErrors } from '../../../settings-faults/allErrors.js'
import { currentHiddenCharacterFindings, hiddenCharacterDetailLines, hiddenCharacterScanCounts } from '../../../text/hiddenCharacterFindings.js'
import { summarizeHiddenCodePoints } from '../../../text/hiddenCodePoints.js'
import { relativeToCwd, type CheckSpec } from '../../healthReport.js'

export function instructionProfileCheck(): CheckSpec {
  return {
    id: 'instruction-profile',
    label: 'Instruction profile',
    run: async () => {
      const bundle = await getInstructionBundle()
      const { resolution, adapterId, skippedDuplicates, diagnostics, loadReason } =
        getInstructionCompositionState()
      const requested = `${resolution.requested}${
        resolution.requestedOrigin === 'default'
          ? ''
          : ` (${resolution.requestedOrigin})`
      }`
      const nativeCount = bundle.entries.filter(
        e => e.family === 'native',
      ).length
      const actionableDiagnostics = diagnostics.filter(
        d => d.kind !== 'duplicate-content',
      )
      const notes = [
        sharedSourcesNote(bundle.entries),
        skippedDuplicates.length > 0
          ? `${skippedDuplicates.length} identical-content duplicate(s) skipped`
          : null,
        ...actionableDiagnostics.map(
          d => `${d.kind}: ${d.path}${d.parent ? ` (from ${d.parent})` : ''}`,
        ),
      ].filter(Boolean)
      return {
        status: actionableDiagnostics.length > 0
          ? ('warn' as const)
          : ('info' as const),
        evidence:
          `requested ${requested} → resolved ${resolution.resolved} ` +
          `(${adapterId} adapter) · ${bundle.entries.length} source(s)` +
          `${nativeCount > 0 ? ` (${nativeCount} native)` : ''} · ` +
          `digest ${bundle.bundleDigest.slice(0, 12)} · ` +
          `last reload: ${loadReason}` +
          (notes.length > 0 ? ` · ${notes.join(' · ')}` : ''),
        link: '/memory',
      }
    },
  }
}

export function hiddenCharactersCheck(): CheckSpec {
  return {
    id: 'hidden-characters',
    label: 'Hidden characters',
    run: async () => {
      await getInstructionBundle()
      const skills = require('../../../../integrations/skills/loadSkillsDir.js') as typeof import('../../../../integrations/skills/loadSkillsDir.js')
      await skills.getSkillDirCommands(getCwd())
      getSettingsWithAllErrors()
      const counts = hiddenCharacterScanCounts()
      const scanned =
        `${counts.instruction} instruction file(s) · ${counts.skill} skill(s) · ${counts.settings} settings file(s) read as written` +
        ` · ${counts.mcp} MCP tool definition(s) stripped at discovery`
      const found = currentHiddenCharacterFindings()
      if (found.length === 0) {
        return { status: 'ok' as const, evidence: `no hidden characters · ${scanned}` }
      }
      const cwd = getCwd()
      const characters = found.reduce((n, record) => n + record.findings.length, 0)
      const files = found.filter(record => record.source !== 'mcp')
      const mcpRead = found.some(record => record.source === 'mcp' && !record.removed)
      const named = found
        .map(record =>
          record.source === 'mcp'
            ? `MCP tool ${record.path} (${summarizeHiddenCodePoints(record.findings)}${record.removed ? ', removed before the model read it' : ''})`
            : `${relativeToCwd(cwd, record.path)} line ${record.findings[0]!.line} (${summarizeHiddenCodePoints(record.findings)})`,
        )
        .join(' · ')
      return {
        status: 'warn' as const,
        evidence: `${characters} hidden character${characters === 1 ? '' : 's'} in ${found.length} place${found.length === 1 ? '' : 's'} — ${named} · ${scanned}`,
        detail: found.flatMap(hiddenCharacterDetailLines).join('\n'),
        fix:
          files.length > 0
            ? 'Open each named line in an editor that shows invisible characters and delete what you did not write; a direction override or zero-width character in an instruction file is read by the model and seen by nobody. Mercury loaded the files as written and changed nothing.'
            : `The MCP server sent hidden characters in a tool definition; consider whether you trust that server. ${mcpRead ? 'Variation selectors survive the discovery strip, so the model reads them as sent.' : 'Mercury stripped them before the model read the definition.'}`,
      }
    },
  }
}

export function requestContextCheck(): CheckSpec {
  return {
    id: 'request-context',
    label: 'Request context',
    run: async () => {
      const provenance = readPromptProvenance()
      const bundle = await getInstructionBundle()
      const instructionChars = bundle.entries.reduce(
        (a, e) => a + e.contentLength,
        0,
      )
      if (provenance === null) {
        return {
          status: 'info' as const,
          evidence:
            `no composition recorded yet this session · instructions ` +
            `${bundle.entries.length} source(s) · ${instructionChars} chars`,
        }
      }
      const OVERSIZED_SECTION_CHARS = 20_000
      const oversized = provenance.sections.filter(
        se => se.cacheClass !== 'turn' && se.chars > OVERSIZED_SECTION_CHARS,
      )
      const dupNames = new Map<string, number>()
      for (const se of provenance.sections) {
        dupNames.set(se.name, (dupNames.get(se.name) ?? 0) + 1)
      }
      const duplicated = [...dupNames.entries()].filter(([, n]) => n > 1)
      const top = [...provenance.sections]
        .sort((a, b) => b.chars - a.chars)
        .slice(0, 3)
        .map(se => `${se.name} ${se.chars}`)
        .join(' · ')
      const notes = [
        ...oversized.map(
          se => `oversized always-loaded section ${se.name} (${se.chars} chars — owner ${se.owner})`,
        ),
        ...duplicated.map(([name, n]) => `duplicate section name ${name} ×${n}`),
        provenance.absent.length > 0
          ? `${provenance.absent.length} registry section(s) absent (composed away)`
          : null,
      ].filter(Boolean)
      return {
        status: oversized.length > 0 || duplicated.length > 0
          ? ('warn' as const)
          : ('info' as const),
        evidence:
          `system prompt ${provenance.totalChars} chars / ${provenance.segmentCount} segments ` +
          `(digest ${provenance.digest}) · instructions ${instructionChars} chars / ` +
          `${bundle.entries.length} source(s) · top: ${top}` +
          (notes.length > 0 ? ` · ${notes.join(' · ')}` : ''),
      }
    },
  }
}

export function memoryLifecycleCheck(): CheckSpec {
  return {
    id: 'memory-lifecycle',
    label: 'Memory lifecycle',
    run: async () => {
      const { mnemeEnabled, mnemeLibraryDir } = await import('../../../../sessions/mneme/mnemeGates.js')
      if (!mnemeEnabled()) {
        return {
          status: 'off' as const,
          evidence: 'memory is off (memory.enabled is false in settings) — nothing saved or recalled this session',
        }
      }
      const { mnemeStatus } = await import('../../../../sessions/mneme/mnemeMaintenance.js')
      const { mnemeUnreadSentence } = await import('../../../../sessions/mneme/mnemeUnread.js')
      const st = mnemeStatus()
      const unread = mnemeUnreadSentence([mnemeLibraryDir()])
      if (unread !== null) {
        return {
          status: 'warn' as const,
          evidence: unread,
        }
      }
      const evidence = [
        `memory: ${st.entryCount} current · ${st.buffered + st.pendingConsuming} recent · ${st.historyCount} history · ${st.topicCount} topics`,
        st.running ? 'maintenance running' : st.due ? `maintenance DUE (${st.dueReason})` : 'maintenance idle',
        st.lastConsolidatedAt ? `last ${st.lastConsolidatedAt.slice(0, 16)}` : 'never consolidated',
      ].join(' · ')
      if (st.degraded.length > 0) {
        return {
          status: 'warn' as const,
          evidence,
          detail: st.degraded.join(' · '),
          fix: 'Run maintenance from /memory (the maintenance row) — it reaps dead locks and recovers stranded observations.',
        }
      }
      return { status: 'ok' as const, evidence }
    },
  }
}
