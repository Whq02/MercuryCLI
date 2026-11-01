process.env['FORCE_COLOR'] = '1'
delete process.env['NO_COLOR']
import type { SystemCrewChatMessage } from '../../src/types/message.ts'

const { makeTally } = await import('./crew-world.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const React = (await import('react')).default
const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { CrewChatRow } = await import('../../src/components/messages/CrewChatRow.js')

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

const paint = async (kind: SystemCrewChatMessage['kind'], content: string, theme?: string): Promise<string> => {
  if (theme === undefined) delete process.env['MERCURY_THEME_PIN']
  else process.env['MERCURY_THEME_PIN'] = theme
  return renderToAnsiString(mounted(h(CrewChatRow, { message: row(kind, content) })), 100)
}

const blockerColoured = await paint('blocker', 'MONO-BLOCKER the build is red')
const askColoured = await paint('ask', 'MONO-ASK which file')
tally.check('with colour on, the row carries colour codes at all (the render is styled)', blockerColoured.includes('\u001b['), blockerColoured)
tally.check('with colour on, a blocker body is not bold', !blockerColoured.includes(BOLD), blockerColoured)
tally.check('with colour on, an ask body is not bold', !askColoured.includes(BOLD), askColoured)

const blockerMono = await paint('blocker', 'MONO-BLOCKER the build is red', 'mono')
const askMono = await paint('ask', 'MONO-ASK which file', 'mono')
tally.check('the Black and white theme paints no colour on the row', !/\u001b\[(3[0-7]|9[0-7]|38;)/.test(blockerMono), blockerMono)
tally.check('under stripped colour, the blocker body is bold', blockerMono.includes(BOLD), blockerMono)
tally.check('under stripped colour, the blocker body still carries its words', blockerMono.includes('MONO-BLOCKER the build is red'), blockerMono)
tally.check('under stripped colour, an ask body is not bold', !askMono.includes(BOLD), askMono)
tally.check('under stripped colour, no new word is added to the row', blockerMono.replace(/\u001b\[[0-9;]*m/g, '').split(']')[1]?.trim() === 'MONO-BLOCKER the build is red', blockerMono)
delete process.env['MERCURY_THEME_PIN']

tally.finish()
