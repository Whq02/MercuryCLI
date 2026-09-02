/**
 * Static argument table for `timeout`. Its second positional argument is
 * flagged `isCommand`, marking the trailing command for analysis.
 */
import type { CommandSpec } from '../registry.js'

const timeout: CommandSpec = {
  name: 'timeout',
  description: 'Run a command with a time limit',
  args: [
    { name: 'duration', description: 'Time limit, e.g. 10, 5s, 2m' },
    { name: 'command', isCommand: true },
  ],
}

export default timeout
