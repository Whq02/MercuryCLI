import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { AMBER, FAINT, IVORY, SECOND } from './mercuryPalette.js'
import { CommandCenter, SectionHeader, StateBadge } from './mercury-ui/components.js'
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'


type ConfigEntry = { name: string; detail: string; via: string }

const ENTRIES: ConfigEntry[] = [
  { name: 'Theme', detail: 'terminal colour scheme', via: '/appearance' },
  { name: 'Model', detail: 'active main-loop model', via: '/model' },
  { name: 'Language', detail: 'response language', via: '/config' },
  { name: 'Permissions', detail: 'tool permission rules', via: '/permissions' },
  { name: 'MCP servers', detail: 'configured MCP roster', via: '/mcp' },
  { name: 'Keybindings', detail: 'editor + REPL shortcuts', via: '/keybindings' },
  { name: 'Memory', detail: 'project + user MERCURY.md', via: '/memory' },
]

const NAME_WIDTH = 16
const DETAIL_WIDTH = 34

export function MercuryConfig({
  onClose,
  isActive = true,
}: {
  onClose: () => void
  isActive?: boolean
}): React.ReactNode {
  const accent = useSessionAccent().accent
  const [sel, setSel] = useState(0)
  const [note, setNote] = useState<string | null>(null)

  const pastOpenEvent = useOpenEventGate()

  const overlayToken = useRegisterOverlay('config', isActive)
  useInput(
    (input, key, event) => {
      if (!isActive) return
      const action = decodeNavKey(input, key, { orientation: 'vertical' })
      if (action === 'cancel') {
        if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
        event.stopImmediatePropagation()
        onClose()
        return
      }
      if (action === 'movePrevious') {
        event.stopImmediatePropagation()
        setSel(s => Math.max(0, s - 1))
        setNote(null)
        return
      }
      if (action === 'moveNext') {
        event.stopImmediatePropagation()
        setSel(s => Math.min(ENTRIES.length - 1, s + 1))
        setNote(null)
        return
      }
      if (!pastOpenEvent()) return
      if (action === 'activate') {
        event.stopImmediatePropagation()
        const e = ENTRIES[Math.min(sel, ENTRIES.length - 1)]
        if (e) setNote(`${e.name} · edit via ${e.via}`)
        return
      }
    },
    { isActive },
  )

  return (
    <CommandCenter view="config" onClose={onClose} captureInput={false} footer={isActive ? '↑↓ move · ↵ where to edit' : 'showcase specimen — keys inert'}>
      <Box marginTop={1}>
        <Text>
          <StateBadge state="live" label="config index" />
          <Text color={FAINT}> · routes to the real editors — this surface does not mutate settings</Text>
        </Text>
      </Box>

      <SectionHeader count={ENTRIES.length}>Categories</SectionHeader>
      {ENTRIES.map((e, i) => {
        const here = i === sel
        return (
          <Text key={e.name}>
            <Text color={here ? accent : FAINT}>{here ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={here ? IVORY : SECOND}>{padTo(truncateToWidth(e.name, NAME_WIDTH), NAME_WIDTH)}</Text>
            <Text color={FAINT}>{padTo(truncateToWidth(e.detail, DETAIL_WIDTH), DETAIL_WIDTH)}</Text>
            <Text color={SECOND}>{e.via}</Text>
          </Text>
        )
      })}

      {note ? (
        <Box marginTop={1}>
          <Text>
            <StateBadge state="gated" label="" mono />
            <Text color={AMBER}>{truncateToWidth(note, 72)}</Text>
          </Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}
