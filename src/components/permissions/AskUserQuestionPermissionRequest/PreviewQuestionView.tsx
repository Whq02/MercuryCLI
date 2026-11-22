import figures from 'figures'
import { GLYPH } from '../../../utils/glyphs.js'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text } from '../../../ink.js'
import { useOptionalKeybindingContext } from '../../../keybindings/KeybindingContext.js'
import { useKeybinding, useKeybindings } from '../../../keybindings/useKeybinding.js'
import { useActionAffordance } from '../../../keybindings/useShortcutDisplay.js'
import { useAppState } from '../../../state/AppState.js'
import type { AppState } from '../../../state/AppState.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { APOLLO_OPTION_LETTERS } from '../../../tools/AskUserQuestionTool/apolloLetters.js'
import { normalizePastedInput } from '../../../input-core/composer-document.js'
import { editorDisplayName, getExternalEditor } from '../../../utils/editor.js'
import { PASTE_THRESHOLD } from '../../../utils/imagePaste.js'
import { editPromptInEditor } from '../../../utils/promptEditor.js'
import { decodeDomNavKey } from '../../mercury-ui/navSemantics.js'
import TextInput from '../../TextInput.js'
import { resolveInterviewLayout } from './interviewLayout.js'
import { PreviewBox } from './PreviewBox.js'
import { previewQuestionBody } from './previewQuestionBody.js'
import type { QuestionState } from './questionState.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type Props = Unbuilt

export function PreviewQuestionView(arg0: Props): React.ReactNode {
  return notBuilt('src/components/permissions/AskUserQuestionPermissionRequest/PreviewQuestionView.tsx:53')
}
