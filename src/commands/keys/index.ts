import type { Command } from '../../commands.js'

// /keys — the Input Atlas: the EFFECTIVE binding table, resolved live from the
// same bindings the runtime resolves against. /keybindings opens
// the file; this reads what the file actually did.
const keys = {
  type: 'local-jsx',
  name: 'keys',
  description:
    'Input atlas — the effective keyboard map: look up a chord, see what shadows what, rebind',
  menuDescription: 'Input atlas — what every key does right now',
  load: () => import('./keys.js'),
} satisfies Command

export default keys
