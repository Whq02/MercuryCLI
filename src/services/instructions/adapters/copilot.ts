import { sharedFormat } from './shared.js'

export const copilotConvention = sharedFormat({
  id: 'copilot',
  label: 'Copilot',
  guides: ['.github/copilot-instructions.md'],
})
