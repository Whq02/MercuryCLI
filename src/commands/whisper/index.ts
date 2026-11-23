import type { Command } from '../catalogue/commands.js'
import type { LocalCommandCall } from '../catalogue/command.js'

const call: LocalCommandCall = async args => (await import('../../crew/crewmates/channelCommand.js')).runChannelCommand('whisper', args)

const whisper = {
  type: 'local',
  name: 'whisper',
  description: 'Post to one crewmate on the board',
  argumentHint: '<name> <text>',
  disableModelInvocation: true,
  supportsNonInteractive: false,
  seat: 'screen',
  load: () => Promise.resolve({ call }),
} satisfies Command

export default whisper
