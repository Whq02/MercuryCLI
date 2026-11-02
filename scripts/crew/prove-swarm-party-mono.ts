process.env['FORCE_COLOR'] = '3'
delete process.env['NO_COLOR']
delete process.env['TMUX']
delete process.env['MERCURY_TRUECOLOR']
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BoardPrincipal, BoardStore } from '../../src/services/crewBoard/contracts.ts'
import type { SystemCrewChatMessage } from '../../src/types/message.ts'

const { makeTally } = await import('./crew-world.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { CrewChatRow } = await import('../../src/components/messages/CrewChatRow.js')
const { Text, useTheme } = await import('../../src/ink.js')
const { resolveMercuryTokens } = await import('../../src/utils/mercuryTokens.ts')
const { TERRA } = await import('../../src/components/mercuryPalette.ts')
const { chatNameColor } = await import('../../src/services/crewBoard/chat.ts')
const { open } = await import('../../src/services/crewBoard/store.ts')
const { partyFeed } = await import('../../src/services/crewBoard/party.ts')

const tally = makeTally('swarm party rows under stripped colour')
const h = React.createElement
const mounted = (node: unknown) => h(AppStateProvider as never, { initialState: getDefaultAppState() } as never, node as never)
const BOLD = '\u001b[1m'

const row = (kind: SystemCrewChatMessage['kind'], content: string): SystemCrewChatMessage => ({
  type: 'system',
  subtype: 'crew_chat',
  content,
  level: 'info',
  uuid: `00000000-0000-4000-8000-00000000000${kind === 'blocker' ? 1 : 2}` as SystemCrewChatMessage['uuid'],
  timestamp: '2026-11-01T11:30:00.000Z',
  seq: kind === 'blocker' ? 1 : 2,
  name: 'lists-judge',
  team: 'lists',
  authorRole: 'peer',
  kind,
  mentions: [],
  addresses: [],
})

const paintRow = async (message: SystemCrewChatMessage, theme?: string): Promise<string> => {
  if (theme === undefined) delete process.env['MERCURY_THEME_PIN']
  else process.env['MERCURY_THEME_PIN'] = theme
  return renderToAnsiString(mounted(h(CrewChatRow, { message })), 100)
}
const paint = (kind: SystemCrewChatMessage['kind'], content: string, theme?: string): Promise<string> => paintRow(row(kind, content), theme)

const blockerColoured = await paint('blocker', 'MONO-BLOCKER the build is red')
const askColoured = await paint('ask', 'MONO-ASK which file')
tally.check('with colour on, the row carries colour codes at all (the render is styled)', blockerColoured.includes('\u001b['), blockerColoured)
tally.check('with colour on, a blocker body is not bold', !blockerColoured.includes(BOLD), blockerColoured)
tally.check('with colour on, an ask body is not bold', !askColoured.includes(BOLD), askColoured)

tally.section('seat inks: one colour per seat, by join order, the same after a cold resume')
const fgAfter = (fg: string, params: number[]): string => {
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!
    if (p === 0 || p === 39) fg = 'default'
    else if (p === 38 && params[i + 1] === 2) { fg = `38;2;${params[i + 2]};${params[i + 3]};${params[i + 4]}`; i += 4 }
    else if (p === 38 && params[i + 1] === 5) { fg = `38;5;${params[i + 2]}`; i += 2 }
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) fg = String(p)
  }
  return fg
}
const inkOf = (rendered: string, plate: string): string | null => {
  let fg = 'default'
  const text: string[] = []
  const inks: string[] = []
  for (let i = 0; i < rendered.length;) {
    const code = /^\u001b\[([0-9;?]*)([A-Za-z])/.exec(rendered.slice(i))
    if (code) {
      if (code[2] === 'm') fg = fgAfter(fg, code[1] === '' ? [0] : code[1]!.split(';').map(Number))
      i += code[0].length
      continue
    }
    text.push(rendered[i]!)
    inks.push(fg)
    i++
  }
  const at = text.join('').indexOf(`[${plate}]`)
  if (at < 0) return null
  const over = new Set(inks.slice(at + 1, at + 1 + plate.length))
  return over.size === 1 ? [...over][0]! : `mixed:${[...over].join('/')}`
}
function Probe(): React.ReactNode {
  const [theme] = useTheme()
  const tokens = resolveMercuryTokens(theme, TERRA)
  return h(Text, null, ...tokens.agentAccents.map((accent, i) => h(Text, { key: i, color: accent.color }, `[A${i}]`)), h(Text, { color: tokens.textPrimary }, '[P0]'))
}
delete process.env['MERCURY_THEME_PIN']
const probe = await renderToAnsiString(mounted(h(Probe)), 100)
const accent = (i: number): string | null => inkOf(probe, `A${i}`)
const primary = inkOf(probe, 'P0')
tally.check('the probe paints eight distinct accents and the primary ink', new Set([...Array.from({ length: 8 }, (_, i) => accent(i)), primary]).size === 9 && accent(0) !== null && primary !== null, probe)

const scratch = mkdtempSync(join(tmpdir(), 'swarm-party-inks-'))
const boardPath = join(scratch, 'board.sqlite')
const session = 'inks-session'
let clock = Date.now()
const openBoard = (): BoardStore => open(boardPath, session, undefined, () => (clock += 20_000))
const principal = (agent: string, name: string, execution = `e-${agent}`, team?: string): BoardPrincipal => ({ author: { sessionId: session, agentId: agent, executionId: execution }, name, ...(team === undefined ? {} : { team }) })
const main = principal('main', 'main')
const seats = Array.from({ length: 7 }, (_, i) => principal(`a-ink-${i + 1}`, `ink-${i + 1}`, undefined, 'inks'))
const rowsOf = async (board: BoardStore): Promise<SystemCrewChatMessage[]> => {
  const rows: SystemCrewChatMessage[] = []
  const feed = partyFeed({ store: () => board, anchor: () => undefined, record: async row => { rows.push(row) } })
  feed.check()
  await new Promise(tick => setTimeout(tick, 0))
  return rows
}
const plateOf = (message: SystemCrewChatMessage): string => (message.captain ? `captain ${message.name}` : message.name)
const inkOfRow = async (message: SystemCrewChatMessage | undefined, theme?: string): Promise<string | null> => (message === undefined ? null : inkOf(await paintRow(message, theme), plateOf(message)))
const named = (rows: SystemCrewChatMessage[], marker: string): SystemCrewChatMessage | undefined => rows.find(row => row.content.includes(marker))
const joined = (rows: SystemCrewChatMessage[], name: string): SystemCrewChatMessage | undefined => rows.find(row => row.name === name && /^joined(?: · team .+)?$/.test(row.content))
const fake = { agentAccents: Array.from({ length: 8 }, (_, i) => ({ name: `c${i}`, color: `c${i}` })), accent: 'x', accentSoft: 'y' } as unknown as Parameters<typeof chatNameColor>[1]
const renamed = ['ink-two', 'ink-second', 'ink-deux', 'ink-zwei', 'ink-dos', 'ink-due', 'ink-dois', 'ink-twee'].find(name => chatNameColor(name, fake) !== 'c2')!

try {
  let board = openBoard()
  tally.check('a new board starts with the channel on, so the rows paint without a command', JSON.stringify(board.chat()) === JSON.stringify({ on: true, filter: { kind: 'all' } }), JSON.stringify(board.chat()))
  board.enroll(main)
  board.reserveEnrollment(main, { agent: seats[0]!.author.agentId, name: seats[0]!.name, team: 'inks', captain: true })
  for (const seat of seats) board.enroll(seat)
  const refused: string[] = []
  for (const [i, seat] of seats.entries()) { const receipt = board.post(seat, { clientOpId: `ink-${i + 1}`, kind: 'result', text: `INK-${i + 1} seat ${i + 1} reports` }); if (!receipt.ok) refused.push(receipt.reason) }
  const lead = board.post(main, { clientOpId: 'ink-lead', kind: 'result', text: 'INK-LEAD the lead notes it' })
  if (!lead.ok) refused.push(lead.reason)
  const owner = board.postOwner(main, { clientOpId: 'ink-owner', text: 'INK-OWNER ship it', channel: 'general' })
  if (!owner.ok) refused.push(owner.reason)
  tally.check('seven seats of one team joined and posted, the lead and the owner posted', refused.length === 0, refused.join(' | '))
  const first = await rowsOf(board)
  tally.check('the feed admitted the launch row, seven Joined rows, seven results, the lead and the owner', first.filter(row => /^joined(?: · team .+)?$/.test(row.content)).length === 7 && seats.every((_, i) => named(first, `INK-${i + 1} `) !== undefined) && named(first, 'INK-LEAD') !== undefined && named(first, 'INK-OWNER') !== undefined && named(first, 'Swarm launched') !== undefined, first.map(row => `[${row.name}] ${row.content}`).join(' | '))
  const inks = await Promise.all(seats.map((_, i) => inkOfRow(named(first, `INK-${i + 1} `))))
  for (const [i, ink] of inks.entries()) tally.check(`seat ${i + 1} (${seats[i]!.name}, joined ${i + 1}${['st', 'nd', 'rd'][i] ?? 'th'}) paints accent ${i + 1}`, ink !== null && ink === accent(i + 1), `${ink} vs ${accent(i + 1)}`)
  tally.check('seven seats of one team paint seven distinct inks', new Set(inks).size === 7 && !inks.includes(null), inks.join(' | '))
  const joinedInks = await Promise.all(seats.map(seat => inkOfRow(joined(first, seat.name))))
  tally.check("a seat's Joined row wears the same ink as its result", joinedInks.every((ink, i) => ink !== null && ink === inks[i]), joinedInks.join(' | '))
  tally.check('the captain plate wears its seat ink whole', named(first, 'INK-1 ')?.captain === true && inks[0] === accent(1), `${String(named(first, 'INK-1 ')?.captain)} ${inks[0]}`)
  tally.check('the lead keeps accent 0 on its post and on the launch row', (await inkOfRow(named(first, 'INK-LEAD'))) === accent(0) && (await inkOfRow(named(first, 'Swarm launched'))) === accent(0), `${await inkOfRow(named(first, 'INK-LEAD'))} / ${await inkOfRow(named(first, 'Swarm launched'))} vs ${accent(0)}`)
  tally.check('the owner keeps the primary ink', (await inkOfRow(named(first, 'INK-OWNER'))) === primary, `${await inkOfRow(named(first, 'INK-OWNER'))} vs ${primary}`)

  board.close()
  board = openBoard()
  const again = board.post(seats[3]!, { clientOpId: 'ink-4-again', kind: 'result', text: 'INK-AGAIN seat 4 after the resume' })
  if (!again.ok) refused.push(again.reason)
  const second = await rowsOf(board)
  tally.check('after a cold resume of the board the same seat paints the same ink', again.ok && (await inkOfRow(named(second, 'INK-AGAIN'))) === inks[3], `${await inkOfRow(named(second, 'INK-AGAIN'))} vs ${inks[3]} (${second.length} rows admitted)`)
  board.enroll(principal(seats[1]!.author.agentId, renamed, 'e-renamed'))
  const rename = board.post(principal(seats[1]!.author.agentId, renamed, 'e-renamed'), { clientOpId: 'ink-2-renamed', kind: 'result', text: 'INK-RENAMED seat 2 under a new name' })
  if (!rename.ok) refused.push(rename.reason)
  const third = await rowsOf(board)
  const renamedRow = named(third, 'INK-RENAMED')
  tally.check(`a seat re-enrolled under a new name (${renamed}) keeps its slot: accent 2, not the name's hash`, rename.ok && renamedRow?.name === renamed && (await inkOfRow(renamedRow)) === accent(2), `${renamedRow?.name} ${await inkOfRow(renamedRow)} vs ${accent(2)}`)
  tally.check('a re-enrolled seat does not join again', !third.some(row => /^joined(?: · team .+)?$/.test(row.content)), third.map(row => `[${row.name}] ${row.content}`).join(' | '))
  const eighth = principal('a-ink-8', 'ink-8', undefined, 'inks')
  board.enroll(eighth)
  const overflow = board.post(eighth, { clientOpId: 'ink-8', kind: 'result', text: 'INK-8 the palette is exhausted' })
  if (!overflow.ok) refused.push(overflow.reason)
  const seventh = board.post(seats[6]!, { clientOpId: 'ink-7-again', kind: 'result', text: 'INK-SEVENTH seat 7 after the eighth joined' })
  if (!seventh.ok) refused.push(seventh.reason)
  const fourth = await rowsOf(board)
  const eighthInk = await inkOfRow(named(fourth, 'INK-8 '))
  tally.check('an eighth seat falls back to the hash: an accent, with the seventh seat still on accent 7', overflow.ok && eighthInk !== null && Array.from({ length: 7 }, (_, i) => accent(i + 1)).includes(eighthInk) && (await inkOfRow(named(fourth, 'INK-SEVENTH'))) === accent(7), `${eighthInk} / ${await inkOfRow(named(fourth, 'INK-SEVENTH'))} vs ${accent(7)}`)
  tally.check('no post was refused along the way', refused.length === 0, refused.join(' | '))
  const slottedMono = await paintRow(named(first, 'INK-3 ')!, 'mono')
  tally.check('under the Black and white theme a seat ink paints no colour either', !/\u001b\[(3[0-7]|9[0-7]|38;)/.test(slottedMono) && slottedMono.includes('INK-3 '), slottedMono)
  delete process.env['MERCURY_THEME_PIN']
  board.close()
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

tally.section('the Black and white theme')
const blockerMono = await paint('blocker', 'MONO-BLOCKER the build is red', 'mono')
const askMono = await paint('ask', 'MONO-ASK which file', 'mono')
tally.check('the Black and white theme paints no colour on the row', !/\u001b\[(3[0-7]|9[0-7]|38;)/.test(blockerMono), blockerMono)
tally.check('under stripped colour, the blocker body is bold', blockerMono.includes(BOLD), blockerMono)
tally.check('under stripped colour, the blocker body still carries its words', blockerMono.includes('MONO-BLOCKER the build is red'), blockerMono)
tally.check('under stripped colour, an ask body is not bold', !askMono.includes(BOLD), askMono)
tally.check('under stripped colour, no new word is added to the row', blockerMono.replace(/\u001b\[[0-9;]*m/g, '').split(']')[1]?.trim() === 'MONO-BLOCKER the build is red', blockerMono)
delete process.env['MERCURY_THEME_PIN']

tally.finish()
