import type { Command } from '../../commands.js'
const chat = { type: 'local-jsx', name: 'chat',
  // Mercury-only surface — hidden on a bare-stamp build.
  isEnabled: () => true, description: 'Chat transcript design — the Mercury transcript surface (live transcript is the REPL)', load: () => import('./chat.js') } satisfies Command
export default chat
