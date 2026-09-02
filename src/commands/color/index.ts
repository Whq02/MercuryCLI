import type { Command } from '../../types/command.js'

const color = {
  type: 'local-jsx',
  name: 'color',
  description: 'Tint the prompt bar for this session (whole-chrome accent: /accent)',
  argumentHint: '<color|default>',
  immediate: true,
  load: () => import('./color.js'),
} satisfies Command

export default color
