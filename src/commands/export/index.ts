import type { Command } from '../../commands.js'
import { shouldNavCommandBeImmediate } from '../../utils/immediateCommand.js'

const exportCommand = {
  type: 'local-jsx',
  name: 'export',
  description: 'Save this conversation as text or JSON (.json), with tool results trimmed and thinking left out',
  argumentHint: '[filename.txt|filename.json]',
  get immediate() {
    return shouldNavCommandBeImmediate()
  },
  load: () => import('./export.js'),
} satisfies Command

export default exportCommand
