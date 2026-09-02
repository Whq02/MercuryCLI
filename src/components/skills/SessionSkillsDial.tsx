import * as React from 'react'
import { useRef } from 'react'
import { Box, Text, useInput } from '../../ink.js'
import {
  getFocusedSessionConnector,
  subscribeThroughFocused,
} from '../../services/engine-connector/focusedConnector.js'
import type { SkillsRosterEntryV1 } from '../../services/engine-connector/types.js'
import { kitDialLine } from '../../commands/mcp/route.js'
import type { CommandResultDisplay } from '../../commands.js'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { CommandCenter } from '../mercury-ui/components.js'
import { FAINT, IVORY } from '../mercury-ui/theme.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { paneWindow } from '../mercury-ui/paneWindow.js'
import { useInteractiveList, type AsyncListNote } from '../mercury-ui/useInteractiveList.js'

// ============================================================================
//  SessionSkillsDial — /skills as THE SESSION'S OWN DIAL (ledger
//  L24(3): "when you do slash skills in the daemon in your active session…
//  that one then has those skills"; L24(5): skills carry THREE states).
//
//  Rows are the FOCUSED SESSION's roster (its runner's own facts — never the
//  screen's command table: the old read-only menu listed the SCREEN's
//  estate, the two-estates confusion /mcp had). The roster speaks the
//  tri-state per row — on (ambient) · invocable (/name only) · off (listed
//  for the on-direction: an off row can be dialed back on in THIS session,
//  which is lawful — the narrowing law binds the kit vs AUTHOR frontmatter,
//  not vs the menu; the menu is a default, not a ceiling). Cycling a row
//  rides the connector's one dial verb (record + live runner, one beat);
//  the receipt paints route.ts's honest arms — a mid-turn dial says
//  "Queued — the dials apply when this turn ends", never silence. No
//  optimistic paint: the roster repaints from the session's own facts.
//
//  Keyboard (the menu's own grammar, compact): ↑↓ move · ↵/space/→ cycle
//  forward · ← cycle back · esc close.
// ============================================================================

const EMPTY_ROSTER: readonly SkillsRosterEntryV1[] = Object.freeze([])

/** The facts-arrival feed: rosters are read on render and the connector's
 *  model feed carries every facts change (its deliberate design) — the
 *  roster's array identity is stable between facts reads (uSES law). */
const subscribeSkillsRoster = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))

function readSkillsRoster(): readonly SkillsRosterEntryV1[] {
  const skills = getFocusedSessionConnector().skillsRoster().skills
  return skills.length === 0 ? EMPTY_ROSTER : skills
}

type SkillDialState = 'on' | 'invocable' | 'off'
const FORWARD: Record<SkillDialState, SkillDialState> = { on: 'invocable', invocable: 'off', off: 'on' }
const BACKWARD: Record<SkillDialState, SkillDialState> = { on: 'off', invocable: 'on', off: 'invocable' }
const stateOf = (row: SkillsRosterEntryV1): SkillDialState => row.state ?? 'on'

/** The empty session's one honest line (contract data). */
export const SKILLS_EMPTY_SESSION_LINE =
  "No skills in this session. The boot menu's MCPs & Skills sets the next session's."

/** The dial screen's estate line (contract data — SESSION, not project). */
export const SKILLS_SESSION_SUBTITLE = "this session's skills — the boot menu sets the next session's"

export function SessionSkillsDial({
  onExit,
}: {
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void
}): React.ReactNode {
  const skills = React.useSyncExternalStore(subscribeSkillsRoster, readSkillsRoster, readSkillsRoster)
  const closedRef = useRef(false)
  const close = (): void => {
    if (closedRef.current) return
    closedRef.current = true
    onExit('Skills dialog dismissed', { display: 'system' })
  }

  const dial = (row: SkillsRosterEntryV1 | null, direction: 1 | -1): AsyncListNote | null => {
    if (row === null) return null
    const next = (direction === 1 ? FORWARD : BACKWARD)[stateOf(row)]
    return {
      pending: `${row.name} → ${next}…`,
      result: getFocusedSessionConnector()
        .setKit({ skills: [{ name: row.name, state: next }] })
        .then(receipt => kitDialLine(receipt, `Skill "${row.name}" ${next}`)),
    }
  }

  // ←/→ direction hand-off into the ↵ action (consumed-and-reset per
  // activation — the boot menu's ←-cycles-back grammar without a second
  // note pipeline).
  const dirRef = useRef<1 | -1>(1)
  const list = useInteractiveList<SkillsRosterEntryV1>({
    rows: skills,
    rowId: row => row.name,
    onClose: close,
    idNamespace: 'session-skills',
    actions: [
      {
        key: 'return',
        hint: 'cycle',
        run: row => {
          const direction = dirRef.current
          dirRef.current = 1
          return dial(row, direction)
        },
      },
      { key: ' ', hint: 'cycle', run: row => dial(row, 1) },
    ],
  })
  // ←/→ cycle back/forward — the vertical list decodes no horizontal motion
  // itself (the boot menu's own grammar).
  useInput(
    (_input, key) => {
      if (!key.leftArrow && !key.rightArrow) return
      if (list.selectedRow === null) return
      dirRef.current = key.leftArrow ? -1 : 1
      list.activate(list.selectedIndex)
    },
    { isActive: skills.length > 0 },
  )

  const subtitle = skills.length === 0 ? 'no skills in this session' : SKILLS_SESSION_SUBTITLE

  // A cursor-following window: the roster lists the bundled skills first,
  // and a project's own rows sat below the fold with no marker at 40 rows.
  // The budget is the painted chrome — border 2 + header 1 + subtitle 1 +
  // top margin 1 + the note row 2 + footer 2 + two overflow counters 2.
  const { columns, rows: termRows } = useTerminalSize()
  const availRows = useModalOrTerminalSize({ rows: termRows, columns }).rows
  const rowCap = Math.max(3, availRows - 11)
  const win = paneWindow(skills.length, list.selectedIndex, rowCap)

  return (
    <CommandCenter
      view="skills"
      subtitle={subtitle}
      onClose={close}
      captureInput={false}
      footer={`${list.motionHint} move · ↵ cycle · esc close`}
    >
      {skills.length === 0 ? (
        <Box marginTop={1}>
          <Text color={FAINT}>{SKILLS_EMPTY_SESSION_LINE}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {win.above > 0 ? <Text color={FAINT}>{'  '}↑ {win.above} more</Text> : null}
          {skills.map((row, i) => {
            if (i < win.start || i >= win.end) return null
            const props = list.rowProps(row, i)
            const state = stateOf(row)
            return (
              <InteractiveRow key={props.id} {...props}>
                <Text>
                  <Text color={state === 'off' ? FAINT : IVORY}>{row.name}</Text>
                  <Text color={FAINT}> · </Text>
                  <Text color={state === 'off' ? FAINT : IVORY}>{state}</Text>
                  {row.description !== '' ? <Text color={FAINT}> · {row.description}</Text> : null}
                </Text>
              </InteractiveRow>
            )
          })}
          {win.below > 0 ? <Text color={FAINT}>{'  '}↓ {win.below} more</Text> : null}
          {list.note !== null ? (
            <Box marginTop={1}>
              <Text color={FAINT}>{list.note}</Text>
            </Box>
          ) : null}
        </Box>
      )}
    </CommandCenter>
  )
}
