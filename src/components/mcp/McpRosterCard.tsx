import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { McpRosterEntryV1, McpRosterV1 } from '../../services/engine-connector/types.js'
import { mcpRosterRowsFailedFirst } from '../../commands/mcp/route.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { CommandCenter } from '../mercury-ui/components.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { paneWindow } from '../mercury-ui/paneWindow.js'
import { FAINT, IVORY } from '../mercury-ui/theme.js'
import { useInteractiveList } from '../mercury-ui/useInteractiveList.js'

// ============================================================================
//  McpRosterCard — /mcp's answer on every seat is a CARD, never a footer
//  line. The facts arm (commands/mcp/route.ts) answers from the focused
//  session's roster; a daemon-hosted seat paints a command's text result on
//  the one-row footer notice, so seven servers' failed reasons clipped past
//  the row and the session had no other surface for them. The card lists
//  every row (the failed first), and the selected row's reason paints whole
//  in the detail line beneath the list. Read-only: the dials stay the /mcp
//  verbs the footer names.
// ============================================================================

/** The card's estate line (contract data — SESSION, not screen). */
export const MCP_SESSION_SUBTITLE = "this session's MCP servers — the boot menu sets the next session's"

/** One row's words: the name and its state; the reason lives in the detail
 *  line, whole, so a long deadline sentence never clips a row. */
export function mcpRosterCardRow(entry: McpRosterEntryV1): string {
  return `${entry.name} · ${entry.type}`
}

/** The selected row's detail: a failed row's own reason and its retry
 *  verb; the other states name the dial that applies to them. */
export function mcpRosterCardDetail(entry: McpRosterEntryV1 | null): string {
  if (entry === null) return ''
  switch (entry.type) {
    case 'failed':
      return `${entry.error !== undefined && entry.error !== '' ? entry.error : 'failed — no reason was recorded'} · /mcp reconnect ${entry.name} retries`
    case 'disabled':
      return `off in this session · /mcp enable ${entry.name} turns it on`
    case 'pending':
      return 'connecting…'
    default:
      return `${entry.type} · /mcp disable ${entry.name} turns it off for this session`
  }
}

export function McpRosterCard({
  roster,
  onDone,
}: {
  roster: McpRosterV1
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  const rows = React.useMemo(() => mcpRosterRowsFailedFirst(roster), [roster])
  const closedRef = React.useRef(false)
  const close = (): void => {
    if (closedRef.current) return
    closedRef.current = true
    // The card was the answer; nothing echoes onto the footer behind it.
    onDone(undefined, { display: 'skip' })
  }
  const list = useInteractiveList<McpRosterEntryV1>({
    rows,
    rowId: row => row.name,
    onClose: close,
    idNamespace: 'mcp-roster',
    actions: [],
  })
  // The window budgets the painted chrome: border 2 + header 1 + subtitle 1
  // + top margin 1 + the detail line 2 + footer 2 + two overflow counters 2.
  const { columns, rows: termRows } = useTerminalSize()
  const availRows = useModalOrTerminalSize({ rows: termRows, columns }).rows
  const rowCap = Math.max(3, availRows - 11)
  const win = paneWindow(rows.length, list.selectedIndex, rowCap)
  const detail = mcpRosterCardDetail(list.selectedRow)
  return (
    <CommandCenter
      view="mcp"
      subtitle={MCP_SESSION_SUBTITLE}
      onClose={close}
      captureInput={false}
      footer={`${list.motionHint} move · esc close · /mcp enable|disable|reconnect <name> dials`}
    >
      <Box flexDirection="column" marginTop={1}>
        {win.above > 0 ? <Text color={FAINT}>{'  '}↑ {win.above} more</Text> : null}
        {rows.map((row, i) => {
          if (i < win.start || i >= win.end) return null
          const props = list.rowProps(row, i)
          const failed = row.type === 'failed'
          return (
            <InteractiveRow key={props.id} {...props}>
              <Text color={failed ? IVORY : row.type === 'disabled' ? FAINT : IVORY}>{mcpRosterCardRow(row)}</Text>
            </InteractiveRow>
          )
        })}
        {win.below > 0 ? <Text color={FAINT}>{'  '}↓ {win.below} more</Text> : null}
        <Box marginTop={1}>
          <Text color={FAINT} wrap="wrap">{detail}</Text>
        </Box>
      </Box>
    </CommandCenter>
  )
}
