import type { Command } from '../../commands.js'
const chat = { type: 'local-jsx', name: 'chat',
  isEnabled: () => true, description: 'Chat transcript design — the Mercury transcript surface (live transcript is the REPL)', load: () => import('./chat.js') } satisfies Command
export default chat
