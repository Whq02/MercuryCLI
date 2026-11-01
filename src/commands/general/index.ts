import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'

const call: LocalCommandCall = async args => (await import('../../utils/crew/channelCommand.js')).runChannelCommand('general', args)

const general = {
  type: 'local',
  name: 'general',
  description: 'Post to every crewmate on the board',
  argumentHint: '<text>',
  disableModelInvocation: true,
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => Promise.resolve({ call }),
} satisfies Command

export default general
