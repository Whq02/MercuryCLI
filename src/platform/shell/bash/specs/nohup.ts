import type { CommandSpec } from '../commandSpecs.js'

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
