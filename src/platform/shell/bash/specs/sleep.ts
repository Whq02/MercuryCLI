import type { CommandSpec } from '../commandSpecs.js'

const spec: CommandSpec = {
  name: 'sleep',
  description: 'Pause for a duration',
  args: {
    name: 'duration',
    description: 'How long to pause — bare seconds, or with a 5s/2m/1h suffix',
    isOptional: false,
  },
}

export default spec
