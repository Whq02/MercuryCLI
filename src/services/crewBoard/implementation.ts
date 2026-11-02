import { z } from 'zod/v4'
import type { Tool, ToolDef } from '../../Tool.js'
import { BOARD_PACKET_RULE, DEFAULT_BOARD_LIMITS, type BoardHost, type BoardLimits, type BoardModule, type BoardPost, type BoardRead, type BoardStore } from './contracts.js'
import { WHEEL_STEP_ROWS } from '../../components/mercury-ui/composerFloor.js'
import { open } from './store.js'
import { existsSync } from 'node:fs'
import { chatKindColor, chatNameColor, chatRows } from './chat.js'
import { displayWidth, padTo } from '../../components/mercury-ui/glyphs.js'
import { truncateToWidthNoEllipsis } from '../../utils/truncate.js'
export { open }

const TIMELINE_LINES = 3
const LAUNCH = 'Launch swarm seats with the Crewmate tool; ToolSearch select:Crewmate loads it. Posting here does not launch agents.'
const launchWords = (tools: readonly Tool[] | undefined): string => tools?.some(tool => tool.name === 'Crewmate') ? LAUNCH : 'The lead launches seats.'

export const tail: BoardModule['tail'] = record => {
  if (!existsSync(record.path)) throw new Error('The saved board is no longer available.')
  return open(record.path, record.sessionId, undefined, Date.now, true)
}

export const page: BoardModule['page'] = (record, before, thread, team) => {
  const board = tail(record)
  try { return board.view(before, thread, team) } finally { board.close() }
}

const ref = z.object({ uri: z.string().min(1).max(512), digest: z.string().regex(/^[a-f0-9]{40,64}$/) }).strict()
const boardInputSchema = z.object({
  op: z.enum(['read', 'post', 'swarm_team', 'swarm_captain']),
  seat: z.string().optional(),
  team: z.string().optional(),
  clientOpId: z.string().min(1).max(160).optional(),
  kind: z.enum(['ask', 'answer', 'blocker', 'result', 'correction']).optional(),
  corrects: z.string().max(160).optional(),
  text: z.string().min(1).optional(),
  threadId: z.string().max(160).optional(),
  replyTo: z.string().max(160).optional(),
  taskId: z.string().max(160).optional(),
  about: z.string().max(1200).optional(),
  mentions: z.array(z.string()).optional(),
  to: z.array(z.string()).optional(),
  relatedTasks: z.array(z.string().max(160)).max(16).optional(),
  files: z.array(z.string().max(512)).max(32).optional(),
  refs: z.array(ref).max(8).optional(),
  since: z.number().int().min(0).optional(),
  snapshot: z.number().int().min(0).optional(),
  thread: z.string().max(160).optional(),
  task: z.string().max(160).optional(),
  mentioned: z.string().max(160).optional(),
  acknowledge: z.array(z.string().max(160)).max(32).optional(),
  watch: z.boolean().optional().describe('Subscribe to this team or remember this task/file selection for relevant notifications; no turn is started'),
}).strict()

export function tool(host: BoardHost, store: () => BoardStore | null): Tool {
  const limits = (): BoardLimits => host.limits?.() ?? store()?.limits ?? DEFAULT_BOARD_LIMITS
  const inputSchema = boardInputSchema.extend({ limitTokens: z.number().int().min(1).optional() })
  const allowance = (value: number): string => value === 0 || (host.uncapped?.() ?? store()?.uncapped) ? 'no limit' : value.toLocaleString('en-US')
  return host.buildTool({
    name: 'CrewBoard',
    searchHint: 'read swarm posts or send to seats; the lead can launch agents',
    shouldDefer: true,
    maxResultSizeChars: Infinity,
    inputSchema,
    isReadOnly: input => input.op === 'read' && !input.acknowledge?.length && input.watch === undefined,
    isConcurrencySafe: () => false,
    async description(_input, options) { return `Read and post to this session’s live crew board. ${launchWords(options?.tools)}` },
    async prompt(options) { return `${launchWords(options?.tools)} ${BOARD_PACKET_RULE} read: since/snapshot cursor, thread/task/mentioned/files/team filters; omit team for the general timeline, readable by everyone. Without since, reads continue from your cursor, starting at enrollment. Whole events already handed to you are skipped without charge; skippedSeen counts them since enrollment. since: 0 or since: <seq> deliberately re-reads and is charged. Truncated events stay unread. limitTokens asks for a smaller page; the seat allowance is ${allowance(limits().seatAllowance)}. Events are oldest first; an oversized first event returns truncated text and its id. A tiny budget still returns the id envelope and charges its actual bytes. acknowledge is separate from fetching; watch subscribes to the selected team/task/files. post: clientOpId (reuse only for an identical retry), kind ask|answer|blocker|result|correction, text (${allowance(limits().postChars)} characters; swarm.postChars), optional about (text/path/URL), taskId, refs. An answer names replyTo. A correction names the earlier event id in corrects; it appends without erasing the original. Corrections and answers to your own posts do not count toward the two-round discussion cap. @seat, @team and @all in text, to or mentions deliver the whole post, about and thread at the recipient's next boundary; replies in a thread you started arrive whole too. A post addressed only to unknown names, with no team delivery or @main, is refused. Mixed posts still return unknownMentions. Teams are delivery labels, not private rooms; there are no private messages. Lead only: swarm_team with seat and team assigns a label; swarm_captain with team and seat appoints that team's captain. A seat never appoints itself; it may ask on the board for the lead to agree. No claim, takeover, launch, interrupt or wake operation exists. The harness supplies your identity and team. ${limits().postsPerMinute} posts/minute, burst ${limits().postsPerMinute * 2}, ${limits().postsPerSeat} per seat/wave; context allowance ${allowance(limits().seatAllowance)} per seat and ${allowance(limits().waveAllowance)} for live members of the wave, conservatively charged in UTF-8 bytes. Only relevance-selected delivery degrades to references; mentions, thread replies and requested reads are refused only by the recipient's seat allowance. The lead can use /swarm uncap, /swarm cap and /swarm status; post-rate and post-count guards stay on. Cap notices reach the lead once per seat per allowance. A refusal is not an instruction to poll; continue the task. References are not automatically opened. An ask or blocker from a seat addressed to @main or @all, and a result, answer or correction addressed to @main by name, wake an idle lead in one batched turn; other posts do not wake the lead.` },
    async checkPermissions(input) { return { behavior: 'allow' as const, updatedInput: input } },
    async call(input, context) {
      const board = store()
      const principal = host.principal(context)
      if (principal === null || board === null) return { data: { ok: false, reason: 'This seat is not on the live crew board.' } }
      if (input.op === 'post' && host.paused(principal.author.agentId)) return { data: { ok: false, reason: 'This seat is paused. A post cannot resume it.' } }
      try {
        if (input.op === 'swarm_captain') {
          if (!input.seat || !input.team) return { data: { ok: false, reason: 'swarm_captain needs seat and team.' } }
          return { data: board.assignCaptain(principal, input.team, input.seat) }
        }
        if (input.op === 'swarm_team') {
          if (!input.seat || !input.team) return { data: { ok: false, reason: 'swarm_team needs seat and team.' } }
          return { data: board.assignTeam(principal, input.seat, input.team) }
        }
        if (input.op === 'read') {
          const read: BoardRead = { ...input, mentions: input.mentioned }
          const data = board.read(principal, read)
          return { data: { ...data, ...(data.events.length === 0 && board.view().events.length === 0 ? { hint: launchWords(context.options?.tools) } : {}) } }
        }
        if (!input.kind || !input.text || !input.clientOpId) return { data: { ok: false, reason: 'A post needs kind, text and clientOpId.' } }
        const post: BoardPost = { ...input, kind: input.kind, text: input.text, clientOpId: input.clientOpId }
        return { data: board.post(principal, post) }
      } catch (error) { return { data: { ok: false, reason: error instanceof Error ? error.message : String(error) } } }
    },
    mapToolResultToToolResultBlockParam(result, toolUseId) {
      if ('ok' in result && result.ok === false && result.reason?.startsWith('no seat named ')) return { type: 'tool_result', tool_use_id: toolUseId, content: result.reason, is_error: true }
      return { type: 'tool_result', tool_use_id: toolUseId, content: JSON.stringify(result) }
    },
    renderToolUseMessage(input) { return input.op },
    renderToolResultMessage(result) { return 'reason' in result ? String(result.reason ?? '') : 'events' in result ? `${result.events.length} posts` : 'Posted' },
  } satisfies ToolDef<typeof inputSchema>)
}

export const view: BoardModule['view'] = host => {
  const { React, Text, Box, width, height, tokens } = host
  const [live, setLive] = React.useState(host.snapshot)
  const [selected, setSelected] = React.useState<string | undefined>()
  const [earlier, setEarlier] = React.useState<number[]>([])
  const before = earlier.at(-1)
  const [thread, setThread] = React.useState<string | undefined>()
  const [team, setTeam] = React.useState<string | undefined>()
  const [scroll, setScroll] = React.useState(0)
  const record = host.snapshot.record
  React.useEffect(() => {
    setLive(host.snapshot)
    if (!record) return
    const reader = tail(record)
    const refresh = () => setLive(reader.view())
    const stop = reader.subscribe(refresh)
    refresh()
    return () => { stop(); reader.close() }
  }, [record?.path, record?.sessionId, host.snapshot.on])
  const snapshot = React.useMemo(() => record && (before !== undefined || thread !== undefined || team !== undefined) ? page(record, before, thread, thread ? undefined : team) : live, [live, before, thread, team, record?.path, record?.sessionId])
  const entries = chatRows(snapshot, host.traffic, thread ? undefined : team, thread)
  const index = selected === undefined ? entries.length - 1 : Math.max(0, entries.findIndex(row => row.id === selected))
  const channels = [undefined, ...(live.teams ?? [])]
  host.useInput((_input, key, event) => {
    if (key.wheelUp || key.wheelDown) event.stopImmediatePropagation()
    if (key.escape) { if (thread !== undefined) { setThread(undefined); setEarlier([]); setScroll(0) } else host.onBack(); return }
    if (key.leftArrow || key.rightArrow) {
      const next = (channels.indexOf(team) + (key.leftArrow ? -1 : 1) + channels.length) % channels.length
      setTeam(channels[next]); setThread(undefined); setEarlier([]); setSelected(undefined); setScroll(0); return
    }
    if (key.return && entries[index]) { setThread(entries[index]!.thread); setEarlier([]); setScroll(0); return }
    if (thread !== undefined) {
      const end = Math.max(0, detailLines.length - room)
      const offset = Math.min(scroll, end)
      if (key.upArrow && offset === 0 && snapshot.omitted && snapshot.events[0]) { setEarlier(history => [...history, snapshot.events[0]!.seq]); setScroll(Number.MAX_SAFE_INTEGER); return }
      if (key.downArrow && offset === end && before !== undefined) { setEarlier(history => history.slice(0, -1)); setScroll(0); return }
      const step = key.wheelUp || key.wheelDown ? WHEEL_STEP_ROWS : 1
      if (key.upArrow) setScroll(Math.max(0, offset - step))
      if (key.downArrow) setScroll(Math.min(end, offset + step))
      return
    }
    if (key.upArrow && index === 0 && snapshot.omitted && snapshot.events[0]) { setEarlier(history => [...history, snapshot.events[0]!.seq]); setSelected(undefined); return }
    if (key.downArrow && index === entries.length - 1 && before !== undefined) { setEarlier(history => history.slice(0, -1)); setSelected(undefined); return }
    if (key.upArrow) setSelected(entries[Math.max(0, index - 1)]?.id)
    if (key.downArrow) setSelected(index + 1 >= entries.length - 1 ? undefined : entries[index + 1]?.id)
  })
  const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
  const bodyLines = (text: string, bodyWidth: number): string[] => host.wrapText(text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' '), bodyWidth, 'wrap').split('\n')
  const allRows = chatRows(live, host.traffic)
  const names = [...(live.names ?? []), ...allRows.map(entry => entry.name)]
  const nameWidth = Math.max(2, ...names.map(name => displayWidth(`[${clean(name)}]`)))
  const minutes = new Map<string, number>()
  for (const entry of allRows) minutes.set(entry.at.slice(0, 16), (minutes.get(entry.at.slice(0, 16)) ?? 0) + 1)
  const duplicateMinutes = new Set([...(live.duplicateMinutes ?? []), ...[...minutes].filter(([, count]) => count > 1).map(([minute]) => minute)])
  const timeWidth = duplicateMinutes.size ? 8 : 5
  const highlight = (text: string) => clean(text).split(/(@[\p{L}\p{N}_][\p{L}\p{N}_.-]*)/u).map((part, i) => React.createElement(Text, { key: i, bold: part.startsWith('@'), color: tokens.textPrimary }, part))
  const line = (text: string, key: string) => React.createElement(Text, { key, color: tokens.textPrimary, wrap: 'truncate-end' }, text)
  const row = (entry: typeof entries[number], on: boolean, body = true) => {
    const marker = on ? '› ' : '  '
    const gutter = entry.reply ? '  └ ' : ''
    const time = padTo(entry.at.slice(11, duplicateMinutes.has(entry.at.slice(0, 16)) ? 19 : 16), timeWidth)
    const name = padTo(`[${clean(entry.name)}]`, nameWidth)
    const traffic = entry.traffic ? '[traffic] ' : ' '.repeat(10)
    const label = `[${entry.kind}]`
    const channel = !body && entry.team ? `[${clean(entry.team)}] ` : ''
    const prefix = `${marker}${gutter}${time}  ${name} ${traffic}${channel}${label}: `
    const bodyWidth = Math.max(1, width - displayWidth(prefix))
    const lines = body ? bodyLines(entry.text, bodyWidth) : []
    const shown = lines.length > TIMELINE_LINES ? [...lines.slice(0, TIMELINE_LINES - 1), `${truncateToWidthNoEllipsis(lines[TIMELINE_LINES - 1]!, bodyWidth - 1)}…`] : lines
    return [
      React.createElement(Text, { key: entry.id, color: tokens.textPrimary, wrap: 'truncate-end' },
        React.createElement(Text, { color: on ? tokens.focus : tokens.textMuted }, marker),
        React.createElement(Text, { color: tokens.textMuted }, `${gutter}${time}  `),
        React.createElement(Text, { color: chatNameColor(entry.colorName, tokens, entry.slot), bold: true }, name), ' ',
        React.createElement(Text, { color: tokens.textMuted }, traffic + channel),
        React.createElement(Text, { color: chatKindColor(entry.kind, tokens) }, label), ': ',
        ...(body ? highlight(shown[0] ?? '') : [])),
      ...shown.slice(1).map((text, i) => React.createElement(Text, { key: `${entry.id}-${i + 1}`, color: tokens.textPrimary, wrap: 'truncate-end' }, ' '.repeat(displayWidth(prefix)), ...highlight(text))),
    ]
  }
  const room = Math.max(1, height - 2)
  const timeline = entries.flatMap((entry, i) => [...(i && entries[i - 1]!.thread !== entry.thread ? [React.createElement(Box, { key: `gap-${entry.id}`, height: 1, flexShrink: 0 })] : []), ...row(entry, i === index)])
  const selectedId = entries[index]?.id
  const selectedLine = selectedId === undefined ? -1 : timeline.findLastIndex(node => node.key === selectedId || String(node.key).startsWith(`${selectedId}-`))
  const floor = Math.max(0, selectedLine - room + 1)
  const heads = entries.map(entry => timeline.findIndex(node => node.key === entry.id))
  const start = heads.find(head => head >= floor && head <= (heads[index] ?? -1)) ?? floor
  const detailLines = entries.flatMap(entry => {
    const indent = entry.reply ? '      ' : '  '
    const event = snapshot.events.find(event => event.eventId === entry.id)
    const detail = [entry.text, ...(event?.about ? [event.about] : []), ...(event?.refs.map(ref => `${ref.uri} · ${ref.digest}`) ?? [])]
    return [...row(entry, false, false), ...detail.flatMap((text, block) => bodyLines(text, Math.max(1, width - indent.length)).map((text, i) => React.createElement(Text, { key: `${entry.id}-${block}-${i}`, color: tokens.textPrimary, wrap: 'truncate-end' }, indent, ...highlight(text))))]
  })
  const detailStart = Math.min(scroll, Math.max(0, detailLines.length - room))
  return React.createElement(Box, { flexDirection: 'column', width, height },
    React.createElement(Text, { color: tokens.textMuted, wrap: 'truncate-end' }, ...channels.flatMap((channel, i) => [i ? ' · ' : '', React.createElement(Text, { key: channel ?? 'general', bold: channel === team, color: channel === team ? tokens.accent : tokens.textMuted }, channel ?? 'General')])),
    React.createElement(Box, { flexDirection: 'column', height: room, overflow: 'hidden' }, ...(thread === undefined ? timeline.slice(start, start + room) : detailLines.slice(detailStart, detailStart + room)), ...(entries.length === 0 ? [line('No posts yet', 'empty')] : [])),
    React.createElement(Text, { color: tokens.textMuted, wrap: 'truncate-end' }, '↑↓ move · ↵ open thread · ←→ channel · esc close'))
}
