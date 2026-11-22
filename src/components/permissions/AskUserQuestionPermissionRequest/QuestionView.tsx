import figures from 'figures'
import React, { useCallback, useContext, useRef, useState } from 'react'
import { CockpitActiveContext } from '../../../context/cockpitActiveContext.js'
import type { KeyboardEvent } from '../../../ink/events/keyboard-event.js'
import { Box, Text, useInput } from '../../../ink.js'
import { useOptionalKeybindingContext } from '../../../keybindings/KeybindingContext.js'
import { useActionAffordance } from '../../../keybindings/useShortcutDisplay.js'
import { useAppState } from '../../../state/AppState.js'
import type { AppState } from '../../../state/AppState.js'
import type { Question } from '../../../tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { DISCUSS_OPTION_LABEL } from '../../../tools/AskUserQuestionTool/prompt.js'
import {
  apolloCustomIndexLabel,
  apolloIndexLabel,
} from '../../../tools/AskUserQuestionTool/apolloLetters.js'
import type { PastedContent } from '../../../utils/config.js'
import { editorDisplayName, getExternalEditor } from '../../../utils/editor.js'
import type { ImageDimensions } from '../../../utils/imageResizer.js'
import { editPromptInEditor } from '../../../utils/promptEditor.js'
import { type OptionWithDescription, Select, SelectMulti } from '../../CustomSelect/index.js'
import { decodeDomNavKey } from '../../mercury-ui/navSemantics.js'
import { Divider } from '../../design-system/Divider.js'
import { PermissionRequestTitle } from '../PermissionRequestTitle.js'
import { PreviewQuestionView } from './PreviewQuestionView.js'
import { QuestionNavigationBar } from './QuestionNavigationBar.js'
import { OTHER_OPTION_VALUE, type QuestionState } from './questionState.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type Props = Unbuilt

export function QuestionView(props: Props): React.ReactNode {
  return notBuilt('src/components/permissions/AskUserQuestionPermissionRequest/QuestionView.tsx:66')
}
