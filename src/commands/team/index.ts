import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const call: LocalCommandCall = async args => (await import('../../utils/crew/channelCommand.js')).runChannelCommand('team', args)

const team = {
  type: 'local',
  name: 'team',
  description: 'Post to one team on the board',
  argumentHint: '<name> <text>',
  disableModelInvocation: true,
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => Promise.resolve({ call }),
} satisfies Command

export default team
