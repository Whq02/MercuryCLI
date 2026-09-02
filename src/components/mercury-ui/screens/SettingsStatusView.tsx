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
  facts: StatusFact[]
  retention?: StatusFact[]
  mcp: StatusMcp[]
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

  const { columns: termCols, rows: termRows } = useTerminalSize()
  const availRows = useModalOrTerminalSize({ rows: termRows, columns: termCols }).rows
  const factWin = paneWindow(facts.length, sel, Math.max(4, availRows - 24))
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

      {
}
      <SectionHeader count={facts.length}>Session &amp; environment</SectionHeader>
      {factWin.above > 0 ? <Text color={FAINT}>{'  '}↑ {factWin.above} more</Text> : null}
      {facts.map((r, i) => {
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

      {
}
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
