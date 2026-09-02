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
