import type { CommandSpec } from '../registry.js'

// nohup wraps another command, so its argument is itself parsed as a command.
const spec: CommandSpec = {
  name: 'nohup',
  description: 'Keep a command running after the terminal hangs up',
  args: {
    name: 'command',
    description: 'The command nohup wraps',
    isCommand: true,
  },
}

export default spec
