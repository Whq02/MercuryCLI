import type { Command } from '../catalogue/commands.js'
import type { LocalCommandCall } from '../catalogue/command.js'

const call: LocalCommandCall = async args => (await import('../../crew/crewmates/channelCommand.js')).runChannelCommand('general', args)

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
