import type { Command } from '../../commands.js'
const sessions = { type: 'local-jsx', immediate: true, name: 'sessions', argumentHint: '[<session-id | title>]',
  isEnabled: () => true, description: 'Reopen an earlier session, switch between this project\'s sessions in-place, or start a new one (crewmate chats: /crewmates)', load: () => import('./sessions.js') } satisfies Command
export default sessions
