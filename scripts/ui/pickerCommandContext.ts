import type { Command } from '../../src/commands/catalogue/commands.js'
import { useAppStateStore } from '../../src/screen/app-state/AppState.js'
import { useChatSubmitTools } from '../../src/screen/chat/useChatSubmit.js'
import { useNotifications } from '../../src/screen/notifications/notifications.js'
import { useTheme } from '../../src/screen/themedRenderer.js'

export function usePickerCommandContext(commands: Command[]) {
  const store = useAppStateStore()
  const [themeName] = useTheme()
  const { addNotification, removeNotification } = useNotifications()
  return useChatSubmitTools({ store, setAppState: store.setState, addNotification, removeNotification, debug: false, mergedTools: [], themeName, commandsRef: { current: commands }, apiKeyVerification: { status: 'valid', error: null, reverify: async () => {} }, paintScreenRow: () => {}, setToolJSX: () => {}, setShowRewindPicker: () => {}, setConversationId: () => {} }).getToolUseContext
}
