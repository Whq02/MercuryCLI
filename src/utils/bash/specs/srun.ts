/**
 * Static option/argument table for the SLURM `srun` CLI. Its single
 * positional argument is flagged `isCommand`: that flag tells the command
 * analyser the trailing argument is itself a command to be analysed.
 */
import type { CommandSpec } from '../registry.js'

const srun: CommandSpec = {
  name: 'srun',
  description: 'Run a command on SLURM cluster nodes',
  options: [
    { name: ['-n', '--ntasks'], description: 'Number of tasks to run', args: { name: 'count' } },
    { name: ['-N', '--nodes'], description: 'Number of nodes to allocate', args: { name: 'count' } },
  ],
  args: { name: 'command', isCommand: true },
}

export default srun
