import type { Command } from '../../commands.js'


const command = {
  type: 'local-jsx',
  name: 'scribe-promote',
  description: 'Ratify staged scribe candidates into root memory',
  isEnabled: () => true,
  isHidden: false,
  load: () => import('./scribe-promote.js'),
} satisfies Command

export default command
