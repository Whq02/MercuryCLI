// ============================================================================
//  src/commands/vim/vim.ts — toggle the input editor mode. The stored
//  legacy value `emacs` reads as `normal` (backward compatibility).
// ============================================================================
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export const call: LocalCommandCall = async () => {
  const stored = getGlobalConfig().editorMode ?? 'normal'
  const current = stored === 'emacs' ? 'normal' : stored
  const next = current === 'vim' ? 'normal' : 'vim'
  saveGlobalConfig(config => ({ ...config, editorMode: next }))
  const hint =
    next === 'vim'
      ? 'Escape toggles between insert and normal mode.'
      : 'Standard readline key bindings are in use.'
  return { type: 'text', value: `Editor mode set to ${next}. ${hint}` }
}
