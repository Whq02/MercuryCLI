import type { Command } from '../../commands.js'
const sessions = { type: 'local-jsx', immediate: true, name: 'sessions',
  // Mercury-only surface — hidden on a bare-stamp build.
  isEnabled: () => true, description: 'Session manager — switch between this project\'s sessions in-place, start a new one (teammate chats: /teammates)', load: () => import('./sessions.js') } satisfies Command
export default sessions
