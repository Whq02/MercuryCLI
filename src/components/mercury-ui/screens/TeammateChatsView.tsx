import { pathTailLabel } from '../../../utils/pathLabel.js'
import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { paneWindow } from '../paneWindow.js'
import { padTo } from '../glyphs.js'
import { AMBER, DUNE, FAINT, IVORY, SECOND, TEAL, TERRA } from '../../mercuryPalette.js'
import { CommandCenter } from '../components.js'
import { GLYPH, displayWidth, truncateToWidth } from '../glyphs.js'
import { decodeNavKey } from '../navSemantics.js'
import { useSessionAccent } from '../sessionAccent.js'
import { useMercuryTokens } from '../useMercuryTokens.js'
import { useStableSelection } from '../useStableSelection.js'
import { getCwd } from '../../../utils/cwd.js'
import {
  CREW_MODEL_CHOICES,
  crewEnabled,
  isValidCrewName,
  type CrewModelKey,
} from '../../../daemon/crewSpawn.js'
import {
  crewRosterStatus,
  crewUnreadCounts,
  killCrewTeammate,
  listCrewMembers,
  markCrewChatRead,
  readCrewChat,
  sendCrewMessage,
  spawnCrewTeammate,
  type CrewChatRow,
  type CrewMemberInfo,
} from '../../../utils/crew/crewClient.js'

// ============================================================================
//  TeammateChatsView — the LIVE crew-teammates board (/teammates).
//  Mercury's own, non-beta agent-teams: each teammate is a named long-lived
//  daemon worker (crewSpawn.ts) the operator chats with — instanced,
//  color-coded chats in ONE repo, managed horizontally. This surface owns its
//  input (captureInput=false); the backend is the proven bus (crewClient.ts:
//  control-socket spawn/kill/roster + mailbox send/transcript over the
//  fileStore kernel's live subscriptions). No fabricated state — an offline
//  teammate renders offline, an unreachable daemon renders everything offline.
// ============================================================================

// Chip hues cycle through EXISTING theme tokens (no new hex) — stable per
// index so a teammate keeps its color across renders.
const HUES = [TERRA, AMBER, TEAL, SECOND] as const
const hueFor = (i: number): string => HUES[i % HUES.length]!
const MODEL_KEYS = Object.keys(CREW_MODEL_CHOICES) as CrewModelKey[]

type Mode = 'browse' | 'compose' | 'spawn-name' | 'spawn-model' | 'kill-confirm'

interface Row {
  member: CrewMemberInfo
  online: boolean
  unread: number
}

export function TeammateChatsView({ onClose }: { onClose: () => void }): React.ReactNode {
  // accent stays on carets/selection/your-voice paint; card borders are
  // structure by nesting depth.
  const accent = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const enabled = crewEnabled()
  const cwd = getCwd()

  const [rows, setRows] = useState<Row[]>([])
  // Identity-stable chat cursor: the roster refreshes on a
  // 2s poll — the selected TEAMMATE follows its name, never a stale position.
  const roster = useStableSelection(rows, r => r.member.name)
  const sel = roster.index
  const [chat, setChat] = useState<CrewChatRow[]>([])
  const [mode, setMode] = useState<Mode>('browse')
  const [draft, setDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [modelSel, setModelSel] = useState(0)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  // Bumps to force a data reload (after spawn/kill/send, and on store events).
  const [tick, setTick] = useState(0)
  // Terminal-width-aware layout (Sol 5.6 WS6 — was a fixed 74-cell pane).
  const { columns, rows: termRows } = useTerminalSize()
  const W = Math.max(48, Math.min((columns || 80) - 6, 120))
  // Chat scrollback: null ⇒ follow the tail; ↑ detaches, ↓ at the tail
  // re-attaches. anchor remembers the length at detach for the new-marker.
  const [chatSel, setChatSel] = useState<number | null>(null)
  const chatAnchor = useRef(0)
  const bump = useCallback(() => setTick(t => t + 1), [])

  const cur = rows[Math.min(sel, Math.max(0, rows.length - 1))]

  // Load the roster + unread badges (RPC list + team file + inbox scan).
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      const members = await listCrewMembers()
      const [status, unread] = await Promise.all([
        crewRosterStatus(members.map(m => m.name)),
        crewUnreadCounts(),
      ])
      if (!alive) return
      setRows(
        members.map(m => ({
          member: m,
          online: status.has(m.name),
          unread: unread.get(m.name) ?? 0,
        })),
      )
    })()
    return () => {
      alive = false
    }
  }, [enabled, tick])

  // Poll the roster/unread every 2s (liveness + badges are RPC/file reads, not
  // a store subscription) — cheap, and the board is a transient surface.
  useEffect(() => {
    if (!enabled) return
    const h = setInterval(bump, 2000)
    return () => clearInterval(h)
  }, [enabled, bump])

  // Load the SELECTED chat transcript + mark its replies read on view.
  useEffect(() => {
    if (!enabled || !cur) {
      setChat([])
      return
    }
    let alive = true
    const name = cur.member.name
    void (async () => {
      const rowsC = await readCrewChat(name)
      if (!alive) return
      setChat(rowsC)
      // Viewing this chat clears ITS unread (never another's).
      void markCrewChatRead(name)
    })()
    return () => {
      alive = false
    }
  }, [enabled, cur?.member.name, tick])

  const doSend = useCallback(async () => {
    const v = draft.trim()
    const name = cur?.member.name
    if (!v || !name) return
    if (!cur?.online) {
      setNote(`@${name} is offline — respawn it (r) before sending`)
      return
    }
    setDraft('')
    const ok = await sendCrewMessage(name, v)
    setNote(ok ? '' : 'send failed — see /health')
    bump()
  }, [draft, cur, bump])

  const doSpawn = useCallback(
    async (name: string, modelKey: CrewModelKey) => {
      setBusy(true)
      setNote(`spawning @${name} (${CREW_MODEL_CHOICES[modelKey].model})…`)
      const r = await spawnCrewTeammate(name, modelKey, cwd)
      setBusy(false)
      if (r.ok) {
        setNote(`@${name} spawned — say hello`)
        setNameDraft('')
        bump()
      } else {
        setNote(`spawn refused: ${r.error ?? 'unknown'}`)
      }
    },
    [cwd, bump],
  )

  const doKill = useCallback(async () => {
    const name = cur?.member.name
    if (!name) return
    setBusy(true)
    const r = await killCrewTeammate(name)
    setBusy(false)
    setNote(r.ok ? `@${name} stopped (chat kept — respawn to resume)` : `stop failed: ${r.error ?? 'unknown'}`)
    bump()
  }, [cur, bump])

  useInput((input, key) => {
    if (busy) {
      // esc stays LIVE while a spawn/stop RPC is in flight: the retry
      // ladder against a wedged daemon runs up to ~51s (15×(3000+400)ms)
      // and this board's single input owner swallowed every key for all of
      // it — a modal with no exit under a footer still reading 'esc close'
      // (TASK-017 S2, teammates-board-key-dead-while-spawning). Closing
      // abandons the WAIT, not the work: the daemon call settles server-side
      // and the roster shows the outcome on reopen.
      if (key.escape) onClose()
      return
    }
    // ── spawn wizard: name entry ──
    if (mode === 'spawn-name') {
      if (key.escape) { setMode('browse'); setNameDraft(''); setNote('') }
      else if (key.return) {
        if (isValidCrewName(nameDraft.trim())) { setMode('spawn-model'); setModelSel(0) }
        else setNote('name must be [a-z][a-z0-9-]{1,15} (letter-first, not reserved)')
      } else if (key.backspace || key.delete) setNameDraft(d => d.slice(0, -1))
      else if (input && !key.ctrl && !key.meta) setNameDraft(d => (d + input).toLowerCase())
      return
    }
    // ── spawn wizard: model pick (the ask-the-operator rule, as UI) ──
    // A HORIZONTAL chip row — ←→ move, ↑↓ deliberately decode nothing
    // (navSemantics: never a silent second spelling; the hint says '←→ model').
    if (mode === 'spawn-model') {
      const a = decodeNavKey(input, key, { orientation: 'horizontal' })
      if (a === 'cancel') { setMode('spawn-name'); setNote('') }
      else if (a === 'moveLeft') setModelSel(s => Math.max(0, s - 1))
      else if (a === 'moveRight') setModelSel(s => Math.min(MODEL_KEYS.length - 1, s + 1))
      else if (a === 'activate') { const mk = MODEL_KEYS[modelSel]!; const nm = nameDraft.trim(); setMode('browse'); void doSpawn(nm, mk) }
      return
    }
    // ── kill confirm ──
    if (mode === 'kill-confirm') {
      if (key.escape || input === 'n') { setMode('browse'); setNote('') }
      else if (input === 'y' || key.return) { setMode('browse'); void doKill() }
      return
    }
    // ── compose ──
    if (mode === 'compose') {
      if (key.escape) { setMode('browse'); setNote('') }
      else if (key.return) void doSend()
      else if (key.backspace || key.delete) setDraft(d => d.slice(0, -1))
      else if (input && !key.ctrl && !key.meta) setDraft(d => d + input)
      return
    }
    // ── browse — TWO visible axes, decoded separately (navSemantics): the
    // chat tabs are a HORIZONTAL strip (←→), the transcript scrollback is a
    // VERTICAL collection (↑↓). Neither key pair ever means the other axis.
    const tabAxis = decodeNavKey(input, key, { orientation: 'horizontal' })
    const scrollAxis = decodeNavKey(input, key, { orientation: 'vertical' })
    if (tabAxis === 'cancel') { onClose(); return }
    if (tabAxis === 'moveLeft') { setChatSel(null); roster.select(sel - 1) }
    else if (tabAxis === 'moveRight') { setChatSel(null); roster.select(sel + 1) }
    else if (scrollAxis === 'movePrevious') {
      setChatSel(c => {
        if (c === null) chatAnchor.current = chat.length
        return Math.max(0, (c ?? chat.length - 1) - 1)
      })
    }
    else if (scrollAxis === 'moveNext') {
      setChatSel(c => (c === null ? null : c + 1 >= chat.length - 1 ? null : c + 1))
    }
    else if (input === 'n') { setMode('spawn-name'); setNameDraft(''); setNote('') }
    else if (input === 'i' && cur) { setMode('compose'); setNote('') }
    else if (key.return && cur) { setMode('compose'); setNote('') }
    else if (input === 'r' && cur && !cur.online) { const mk0 = MODEL_KEYS[0]!; void doSpawn(cur.member.name, (cur.member.model?.includes('fable-5-1') ? 'fable51' : cur.member.model?.includes('sonnet') ? 'sonnet' : cur.member.model?.includes('fable') ? 'fable' : mk0) as CrewModelKey) }
    else if (input === 'k' && cur && cur.online) { setMode('kill-confirm'); setNote('') }
  })

  // Browse hints track the SELECTED row's real affordances (
  // semantic audit): r fires only on an offline teammate, k only on an online
  // one — advertising both statically left one always-dead key on screen.
  const cur0 = rows[sel]
  const browseVerbs = [
    rows.length > 0 ? '←→ chat · ↑↓ scrollback · ↵/i message' : undefined,
    'n new',
    cur0 && !cur0.online ? 'r respawn' : undefined,
    cur0 && cur0.online ? 'k stop' : undefined,
    'esc close',
  ].filter(Boolean).join(' · ')
  const footer =
    busy ? 'working… · esc close (the spawn/stop finishes in the daemon)'
    : mode === 'compose' ? 'type · ↵ send · esc back'
    : mode === 'spawn-name' ? 'type a name · ↵ next · esc cancel'
    : mode === 'spawn-model' ? '←→ model · ↵ spawn · esc back'
    : mode === 'kill-confirm' ? 'y stop · n keep · esc cancel'
    : browseVerbs

  // ── OFF: honest disabled state ──
  if (!enabled) {
    return (
      <CommandCenter view="teammates" onClose={onClose} footer="esc close" captureInput={false}>
        <Box marginTop={1} flexDirection="column">
          <Text bold color={accent}>teammate chats</Text>
          <Text color={FAINT}>crew is disabled (MERCURY_CREW=0) — no teammates can spawn</Text>
        </Box>
      </CommandCenter>
    )
  }

  return (
    <CommandCenter view="teammates" onClose={onClose} footer={footer} captureInput={false}>
      <Box marginTop={1} justifyContent="space-between" flexWrap="wrap">
        <Text>
          <Text color={FAINT}>repo </Text>
          <Text bold color={IVORY}>{truncateToWidth(pathTailLabel(cwd) || 'repo', 28)}</Text>
          <Text color={FAINT}> · {rows.length} teammate{rows.length === 1 ? '' : 's'} · instanced chats in one repo</Text>
        </Text>
        <Box borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1}>
          <Text color={FAINT}>/teammates · n new</Text>
        </Box>
      </Box>

      {/* Color-coded chips: hue per index, ◐ online / ○ offline, unread badge. */}
      {rows.length > 0 ? (
        <Box marginTop={1} flexDirection="row" flexWrap="wrap">
          {rows.map((r, i) => {
            const on = i === sel
            const hue = hueFor(i)
            return (
              <Box key={r.member.name} borderStyle="round" borderColor={on ? hue : DUNE} paddingX={1} marginRight={1}>
                <Text color={r.online ? hue : FAINT}>{r.online ? '◐' : '○'} </Text>
                <Text bold={on} color={on ? IVORY : hue}>@{r.member.name}</Text>
                {r.unread > 0 ? <Text color={AMBER}> ({r.unread})</Text> : null}
              </Box>
            )
          })}
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FAINT}>no teammates yet — press </Text>
          <Text color={accent}>n</Text>
          <Text color={FAINT}> to spawn your first collaborator</Text>
        </Box>
      )}

      {/* The active chat instance — bordered pane in the teammate's hue. */}
      {cur ? (
        <Box marginTop={1} borderStyle="round" borderColor={hueFor(sel)} paddingX={1} flexDirection="column">
          <Text>
            <Text bold color={hueFor(sel)}>@{cur.member.name}</Text>
            <Text color={FAINT}> · {cur.online ? 'online' : 'offline'}{cur.member.model ? ` · ${cur.member.model}` : ''}</Text>
          </Text>
          {chat.length === 0 ? (
            <Text color={FAINT}>· no messages yet — {cur.online ? 'press ↵ or i to say hello' : 'offline; press r to respawn'}</Text>
          ) : (
            (() => {
              // Height-budgeted scrollback over the WHOLE history (was: the
              // last 8, one line each). The selected message expands wrapped;
              // nameplates pad to one stable column; scrolling up keeps a
              // live ↓-marker counting new arrivals.
              const visible = Math.max(4, Math.min(chat.length, (termRows || 24) - 16))
              const effSel = chatSel === null ? Math.max(0, chat.length - 1) : Math.min(chatSel, chat.length - 1)
              const win = paneWindow(chat.length, effSel, visible)
              const newSince = chatSel !== null ? Math.max(0, chat.length - chatAnchor.current) : 0
              const NAME_W = 12
              return (
                <>
                  {win.above > 0 ? <Text color={FAINT}>  ↑ {win.above} earlier</Text> : null}
                  {chat.slice(win.start, win.end).map((m, wi) => {
                    const gi = win.start + wi
                    const on = gi === effSel && chatSel !== null
                    const name = padTo(truncateToWidth(m.dir === 'out' ? 'you' : `@${cur.member.name}`, NAME_W), NAME_W)
                    const tone = m.dir === 'out' ? accent : hueFor(sel)
                    return on ? (
                      <Box key={gi} flexDirection="column">
                        <Text>
                          <Text color={tone}>{'▸ '}</Text>
                          <Text bold color={tone}>{name}</Text>
                        </Text>
                        <Box paddingLeft={2} width={W - 4}>
                          <Text color={IVORY} wrap="wrap">{m.text}</Text>
                        </Box>
                      </Box>
                    ) : (
                      <Text key={gi} wrap="truncate-end">
                        <Text color={tone}>{gi === effSel ? '▸ ' : '  '}{name}</Text>
                        <Text color={m.dir === 'out' ? IVORY : SECOND}> {truncateToWidth(m.text.replace(/\s+/g, ' '), Math.max(10, W - NAME_W - 6))}</Text>
                      </Text>
                    )
                  })}
                  {win.below > 0 || newSince > 0 ? (
                    <Text color={newSince > 0 ? AMBER : FAINT}>
                      {'  '}↓ {win.below} later{newSince > 0 ? ` · ${newSince} new — ↓ to follow` : ''}
                    </Text>
                  ) : null}
                </>
              )
            })()
          )}
          {mode === 'compose' ? (
            <Box marginTop={1}>
              <Text color={accent}>{GLYPH.prompt} </Text>
              <Text color={IVORY}>{draftTail(draft, W - 4)}</Text>
              <Text color={accent}>▏</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}

      {/* Spawn wizard. */}
      {mode === 'spawn-name' ? (
        <Box marginTop={1} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} flexDirection="column">
          <Text bold color={accent}>new teammate</Text>
          <Text>
            <Text color={FAINT}>name  </Text>
            <Text color={IVORY}>{nameDraft}</Text>
            <Text color={accent}>▏</Text>
          </Text>
        </Box>
      ) : null}
      {mode === 'spawn-model' ? (
        <Box marginTop={1} borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} flexDirection="column">
          <Text bold color={accent}>@{nameDraft.trim()} · pick a model</Text>
          <Box flexDirection="row" marginTop={1}>
            {MODEL_KEYS.map((mk, i) => {
              const on = i === modelSel
              return (
                <Box key={mk} borderStyle="round" borderColor={on ? accent : DUNE} paddingX={1} marginRight={1}>
                  <Text bold={on} color={on ? IVORY : FAINT}>{mk}</Text>
                  <Text color={FAINT}> {CREW_MODEL_CHOICES[mk].model.replace('claude-', '').replace('[1m]', '')}</Text>
                </Box>
              )
            })}
          </Box>
          <Text color={FAINT}>the operator picks the model per teammate — never defaulted silently</Text>
        </Box>
      ) : null}

      {/* Kill confirm. */}
      {mode === 'kill-confirm' && cur ? (
        <Box marginTop={1} borderStyle="round" borderColor={AMBER} paddingX={1}>
          <Text color={AMBER}>stop @{cur.member.name}? its chat is kept — respawn (r) resumes it. </Text>
          <Text color={FAINT}>y / n</Text>
        </Box>
      ) : null}

      {note ? (
        <Box marginTop={1}>
          <Text color={busy ? TEAL : AMBER}>{truncateToWidth(note, W)}</Text>
        </Box>
      ) : null}
    </CommandCenter>
  )
}

// Right-anchored draft tail (shared idiom with MercuryFleetChat): scroll the
// tail so the cursor stays visible instead of wrapping the round border.
function draftTail(s: string, budget: number): string {
  if (budget <= 0) return ''
  if (displayWidth(s) <= budget) return s
  const chars = [...s]
  let i = 0
  while (i < chars.length && displayWidth(chars.slice(i).join('')) > budget) i++
  return chars.slice(i).join('')
}
