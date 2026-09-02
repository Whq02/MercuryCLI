import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    'The session dashboard — version, model, accounts, connectivity, tools',
  immediate: true,
  // the Mercury warm-ink status surface (SettingsStatusView wired to live
  // snapshot data). The base Settings·Status stays as the fallback + the arg path.
  load: () =>
    import('./mercuryStatus.js'),
} satisfies Command

export default status
