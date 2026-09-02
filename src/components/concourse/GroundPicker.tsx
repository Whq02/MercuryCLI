import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { projectDisplayName, type BootProjectFact } from '../../utils/bootCardFacts.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { useInteractiveList } from '../mercury-ui/useInteractiveList.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { paneWindow } from '../mercury-ui/paneWindow.js'

const ROW_CAP = 40
const WINDOW_ROWS = 9

export function GroundPicker({
  currentGround,
  bootGround,
  onPick,
  onClose,
}: {
  currentGround: string
  bootGround: string
  onPick: (dir: string | null) => void
  onClose: () => void
}): React.ReactNode {
  const t = useMercuryTokens()
  useRegisterOverlay('concourse-ground')
  const { columns } = useTerminalSize()
  const [known, setKnown] = useState<BootProjectFact[] | null>(null)
  useEffect(() => {
    let alive = true
    void import('../../utils/bootCardFacts.js')
      .then(m => {
        if (alive) setKnown(m.workedInProjects())
      })
      .catch(() => {
        if (alive) setKnown([])
      })
    return () => {
      alive = false
    }
  }, [])
  const rows = useMemo(() => {
    const out: Array<{ dir: string; base: string; isBoot: boolean }> = []
    const seen = new Set<string>()
    const push = (dir: string, base: string, isBoot: boolean): void => {
      if (seen.has(dir)) return
      seen.add(dir)
      out.push({ dir, base, isBoot })
    }
    push(bootGround, projectDisplayName(bootGround), true)
    for (const p of known ?? []) push(p.dir, p.base, false)
    return out.slice(0, ROW_CAP)
  }, [known, bootGround])
  const list = useInteractiveList({
    rows,
    rowId: r => r.dir,
    onClose,
    idNamespace: 'groundpicker',
    initialId: currentGround,
    actions: [
      {
        key: 'return',
        hint: 'launch here',
        run: row => {
          if (row === null) return null
          onPick(row.isBoot ? null : row.dir)
          return null
        },
      },
    ],
  })
  const width = Math.min(74, Math.max(44, columns - 8))
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={t.info}
      paddingX={1}
      width={width}
      flexShrink={0}
      overflow="hidden"
    >
      <Box height={1} flexShrink={0} overflow="hidden">
        {
}
        <Text wrap="truncate-end">
          <Text color={t.infoText} bold>
            REPO
          </Text>
          <Text color={t.textMuted}> — where new sessions launch; the whole harness follows</Text>
        </Text>
      </Box>
      {known === null ? (
        <Text color={t.textMuted}>remembering the folders Mercury has worked in…</Text>
      ) : (
        (() => {
          const win = paneWindow(rows.length, list.selectedIndex, WINDOW_ROWS)
          return (
            <>
              {win.above > 0 ? (
                <Box height={1} flexShrink={0}>
                  <Text color={t.textMuted}>↑ {win.above} more</Text>
                </Box>
              ) : null}
              {rows.slice(win.start, win.end).map((r, i) => {
                const props = list.rowProps(r, win.start + i)
                const isCurrent = r.dir === currentGround
                return (
                  <Box key={r.dir} height={1} flexShrink={0} overflow="hidden">
                    <InteractiveRow {...props} flexGrow={1}>
                      {hover => (
                        <Box flexDirection="row" width="100%" overflow="hidden">
                          <Text wrap="truncate-end">
                            <Text
                              color={isCurrent ? t.success : props.selected || hover ? t.textPrimary : t.textSecondary}
                              bold={props.selected}
                            >
                              {isCurrent ? `${GLYPH.ok} ` : '  '}
                              {r.base}
                            </Text>
                            <Text color={t.textMuted}>
                              {r.isBoot ? ' · boot folder' : ''} · {r.dir}
                            </Text>
                          </Text>
                        </Box>
                      )}
                    </InteractiveRow>
                  </Box>
                )
              })}
              {win.below > 0 ? (
                <Box height={1} flexShrink={0}>
                  <Text color={t.textMuted}>↓ {win.below} more — keep pressing ↓</Text>
                </Box>
              ) : null}
            </>
          )
        })()
      )}
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color={t.textMuted} wrap="truncate-end">
          ↑↓ move · ↵ launch here · esc close · any other path — tell the coordinator
        </Text>
      </Box>
    </Box>
  )
}
