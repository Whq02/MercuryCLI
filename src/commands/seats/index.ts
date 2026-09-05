import type { Command } from '../../commands.js'


const seats: Command = {
  type: 'local',
  name: 'seats',
  description: 'View or set the seat ceiling — how many model calls may run at once (auto, or a number)',
  argumentHint: '[auto | <number>]',
  supportsNonInteractive: true,
  load: () => import('./applySeats.js'),
}

export default seats
