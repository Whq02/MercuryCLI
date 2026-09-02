// MercuryFleetChat — fullscreen harness center: teammate SELECTOR + message BOX.
// Real Ink, keyboard-driven (the prototype's /fullscreen behavior). ↑↓ select a
// teammate, type to compose, ↵ sends (prompt accent = target). esc exits.
// Wire onSend to the SendMessage tool. Compose as the center rail of FullscreenLayout.
import * as React from 'react'
import { useState } from 'react'
import { Box, Text, useInput } from '../ink.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useStableSelection } from './mercury-ui/useStableSelection.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { displayWidth, GLYPH } from './mercury-ui/glyphs.js'
import { AMBER, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
// Status spine fixed (TEAL/AMBER); identity (TERRA) is the live critter hue.

export type Teammate = { name: string; role: string; state: 'busy' | 'idle' | 'drift'; glyph: string }
type Msg = { who: 'you' | 'agent'; at: string; text: string }
type Props = { team?: Teammate[]; onSend?: (target: string, text: string) => void; onClose?: () => void }

// default to [] (not a fabricated demo team) so an absent OR empty team
// both render the honest empty state. The only live caller (fullscreen) always
// passes the real roster, so no surface loses data.
export function MercuryFleetChat({ team = [], onSend, onClose }: Props): React.ReactNode {
  // Identity accent at render → a live /critter pick re-tints this surface.
  // (accent stays on carets/selection; the compose-box border is
  // structure — focus is carried by the ❯ caret inside it.)
  const TERRA = useSessionAccent().accent
  const tokens = useMercuryTokens()
  // Identity-stable target cursor: the fleet roster is live.
  const fleetSel = useStableSelection(team, t => t.name)
  const sel = fleetSel.index
  const [draft, setDraft] = useState('')
  const [log, setLog] = useState<Msg[]>([])
  // Mount buffer: the ONE Mercury-family surface that lacked it —
  // the Enter that launched /fullscreen must not immediately SEND an empty-ish
  // draft or act on the freshly-mounted list (the idle-keypress class; every
  // sibling picker already rides useOpenEventGate). Arrows/esc/typing stay
  // instant per the kit doctrine; only ↵-send waits.
  const pastMount = useOpenEventGate()
  useInput((input, key) => {
    if (key.upArrow) fleetSel.select(sel - 1)
    else if (key.downArrow) fleetSel.select(sel + 1)
    else if (key.return) { if (!pastMount()) return; const v = draft.trim(); const tm = team[sel]; if (v && tm) { const at = tm.name; setLog(l => [...l, { who: 'you', at, text: v }]); onSend?.(at, v); setDraft('') } }
    else if (key.escape) onClose?.()
    else if (key.backspace || key.delete) setDraft(d => d.slice(0, -1))
    else if (input && !key.ctrl && !key.meta) setDraft(d => d + input)
  })
  const target = team[sel]
  // Right-anchored draft tail: drop leading chars until the visible run fits
  // `budget` cells, so typing past the field width scrolls the tail (cursor
  // stays visible) instead of wrapping + reflowing the round border.
  const draftTail = (s: string, budget: number): string => {
    if (budget <= 0) return ''
    if (displayWidth(s) <= budget) return s
    const chars = [...s]
    let i = 0
    while (i < chars.length && displayWidth(chars.slice(i).join('')) > budget) i++
    return chars.slice(i).join('')
  }
  // Honest empty state — no fleet (solo session). Never fabricate teammates.
  if (!target) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color={TERRA}>fleet</Text>
        <Text color={FAINT}>{'· no teammates yet — launch a team to chat'}</Text>
        <Text color={FAINT}>esc exit</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="row">
      <Box flexDirection="column" borderStyle="round" borderColor={FAINT} paddingX={1} width={28}>
        <Text bold color={TERRA}>fleet  ↑↓</Text>
        {team.map((a, idx) => {
          const on = idx === sel
          return (
            <Text key={a.name}>
              {/* GLYPH.cursor, not ❯ — in-row selection is the ▸ token; ❯ is
                  the prompt affordance (one shape per meaning). */}
              <Text color={on ? TERRA : FAINT}>{on ? GLYPH.cursor : ' '} </Text>
              <Text color={a.state === 'drift' ? AMBER : a.state === 'idle' ? FAINT : TEAL}>{a.glyph} </Text>
              <Text color={on ? TERRA : IVORY}>{a.name}</Text>
              <Text color={FAINT}> {'<' + a.role + '>'}</Text>
            </Text>
          )
        })}
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        <Text bold color={TERRA}>chat → @{target.name}</Text>
        {log.length === 0 ? <Text color={FAINT}>· pick a teammate (↑↓), type a message, ↵ to send</Text>
          : log.map((m, idx) => m.who === 'you'
            ? <Text key={idx}><Text bold color={TERRA}>❯</Text> <Text color={FAINT}>@{m.at}</Text> <Text color={IVORY}>{m.text}</Text></Text>
            : <Text key={idx}><Text color={TEAL}>●</Text> <Text bold color={IVORY}>{m.at}</Text> <Text color={SAND}>{m.text}</Text></Text>)}
        <Box height={1} />
        <Box borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} width={44}>
          {/* prefix '❯ @name ' (2 + name + 1) + cursor (1) reserve; rest is draft budget */}
          <Text bold color={TERRA}>❯ </Text><Text color={FAINT}>@{target.name} </Text><Text color={IVORY}>{draftTail(draft, 44 - 4 - displayWidth(target.name) - 1 - 1)}</Text><Text color={TERRA}>▏</Text>
        </Box>
        <Text color={FAINT}>↑↓ teammate · ↵ send · esc exit</Text>
      </Box>
    </Box>
  )
}
