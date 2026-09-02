import type { CommandSpec } from '../registry.js'

// Like nohup, time takes a whole command as its argument.
const spec: CommandSpec = {
  name: 'time',
  description: 'Measure how long a command takes',
  args: {
    name: 'command',
    description: 'The command being timed',
    isCommand: true,
  },
}

export default spec
