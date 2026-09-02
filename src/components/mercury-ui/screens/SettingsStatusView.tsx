import * as React from 'react'
import { useModalOrTerminalSize } from '../../../context/modalContext.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { Box, Text } from '../../../ink.js'
import { FAINT, IVORY, TEAL } from '../../mercuryPalette.js'
import {
  Chip,
  CommandCenter,
  SectionHeader,
  StateBadge,
  WarningBanner,
} from '../components.js'
import { displayWidth, GLYPH, padTo } from '../glyphs.js'
import { paneWindow } from '../paneWindow.js'
import { useSessionAccent } from '../sessionAccent.js'
import { useInteractiveList } from '../useInteractiveList.js'
import { InteractiveRow } from '../InteractiveRow.js'

// ============================================================================
//  SettingsStatusView — the Settings · Status surface (/status).
//
//  LIVE-ONLY (: the illustrative gallery fallback — fixed
//  example facts + example MCP counts + an example diagnostic — is deleted
//  with the /hud specimen gallery). The parent (commands/status/
//  mercuryStatus.tsx) supplies real, snapshot-sourced `facts` + `mcp`; an
//  unavailable read shows its honest note in the data, never a fabricated
//  value here.
//
//  Identity (cursor · accent rows) follows the session critter; the status
//  spine (teal/amber/crimson) stays fixed in every theme.
// ============================================================================

export type StatusFact = { k: string; v: string; tone?: string; note?: string }
export type StatusMcp = { tone: string; count: string; label: string }

export function SettingsStatusView({
  onClose,
  facts,
  retention,
  mcp,
  diagnostic,
}: {
  onClose: () => void
  /** Real, snapshot-sourced rows — supplied by the live /status wrapper. */
  facts: StatusFact[]
  /** The retention block (owner-read numbers: transcripts kept for good,
   *  recordings aging under the sweep + its window). Same row grammar as
   *  `facts`, painted non-interactive under its own header; omitted rows
   *  paint no section. */
  retention?: StatusFact[]
  mcp: StatusMcp[]
  /** An honest system-diagnostic line (e.g. an unavailable read); omitted when
   *  there is nothing to report. */
  diagnostic?: string
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const { selectedIndex: sel, note, hints, rowProps } = useInteractiveList({
    rows: facts,
    rowId: r => r.k,
    idNamespace: 'status',
    onClose,
    actions: [
      {
        key: 'return',
        hint: 'inspect',
        run: r => `${r?.k ?? 'fact'}: ${r?.v ?? ''} — live value (snapshot)`,
      },
      {
        key: 'r',
        hint: 'refresh',
        run: () => 're-run /status to refresh the snapshot',
      },
    ],
  })

  // Height budget (the /manager derivation): border 2 + header 1 + intro 2 +
  // four SectionHeaders 8 + retention rows ≤2 + mcp row ≤2 + diagnostics 1 +
  // note 2 + footer 2 = ~22, + 2 budgeted overflow counters ⇒ −24, floor 4.
  const { columns: termCols, rows: termRows } = useTerminalSize()
  const availRows = useModalOrTerminalSize({ rows: termRows, columns: termCols }).rows
  const factWin = paneWindow(facts.length, sel, Math.max(4, availRows - 24))
  // FC-127: the label column is the longest on-screen label plus ONE
  // guaranteed separator cell — a 12-cell label under the old fixed
  // padTo(k, 12) filled its own gap and ran into the value.
  const factLabelW = Math.max(12, ...facts.map(r => displayWidth(r.k) + 1))
  const retentionLabelW = Math.max(12, ...(retention ?? []).map(r => displayWidth(r.k) + 1))

  return (
    <CommandCenter view="status" footer={hints} onClose={onClose} captureInput={false}>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <StateBadge state="live" label="settings · status" />
          <Text color={FAINT}> · Mercury session snapshot</Text>
        </Text>
      </Box>

      {/* FC-127: a fixed 12-cell label pad swallowed its own gap — the two
          ruled provider names that are exactly 12 cells (Hugging Face,
          Local models) ran straight into their values, and the 15-cell
          Custom endpoint truncated. The column derives from the longest
          label on screen plus one guaranteed separator cell. */}
      <SectionHeader count={facts.length}>Session &amp; environment</SectionHeader>
      {factWin.above > 0 ? <Text color={FAINT}>{'  '}↑ {factWin.above} more</Text> : null}
      {facts.map((r, i) => {
        // -adjunct windowing (the /manager class): the cursor stays
        // visible inside the clipping modal pane at any fact count.
        if (i < factWin.start || i >= factWin.end) return null
        return (
          <InteractiveRow key={r.k} {...rowProps(r, i)}>
            <Text>
              <Text color={i === sel ? accent : FAINT}>{i === sel ? '▸ ' : '  '}</Text>
              <Text color={FAINT}>{padTo(r.k, factLabelW)}</Text>
              <Text color={r.tone ?? IVORY}>{r.v}</Text>
              {r.note ? <Text color={FAINT}> {r.note}</Text> : null}
            </Text>
          </InteractiveRow>
        )
      })}
      {factWin.below > 0 ? <Text color={FAINT}>{'  '}↓ {factWin.below} more</Text> : null}

      {/* Retention — the estate's promise in real numbers (owner-read by the
          wrapper; this view never counts). Fact-row grammar, non-interactive
          like the MCP block below. */}
      {retention && retention.length > 0 ? (
        <>
          <SectionHeader count={retention.length}>Retention</SectionHeader>
          {retention.map(r => (
            <Text key={r.k}>
              <Text color={FAINT}>{'  '}{padTo(r.k, retentionLabelW)}</Text>
              <Text color={r.tone ?? IVORY}>{r.v}</Text>
              {r.note ? <Text color={FAINT}> {r.note}</Text> : null}
            </Text>
          ))}
        </>
      ) : null}

      <SectionHeader count={mcp.length}>MCP servers</SectionHeader>
      {mcp.length === 0 ? (
        <Text color={FAINT}>none configured</Text>
      ) : (
        <Box>
          {mcp.map((m, i) => (
            <Text key={i}>
              <Text color={m.tone}>{m.count ? `${m.count} ` : ''}{m.label}</Text>
              <Text color={FAINT}>{i < mcp.length - 1 ? ' · ' : ''}</Text>
            </Text>
          ))}
          <Text color={FAINT}> · </Text>
          <Chip tone="accent">/mcp</Chip>
        </Box>
      )}

      <SectionHeader>System diagnostics</SectionHeader>
      {diagnostic ? (
        <WarningBanner tone="warn" title={diagnostic} />
      ) : (
        <Text color={TEAL}>{GLYPH.ok} no issues reported</Text>
      )}

      {note ? (
        <Box marginTop={1}>
          <Text>
            <StateBadge state="live" label="live" />
            <Text color={FAINT}> · </Text>
            <Text color={IVORY}>{note}</Text>
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FAINT}>↑↓ move · ↵ inspect · r refresh · esc close</Text>
        </Box>
      )}
    </CommandCenter>
  )
}
