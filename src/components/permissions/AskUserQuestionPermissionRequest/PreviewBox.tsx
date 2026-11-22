import React, { Suspense, use, useMemo } from 'react'
import { useSettings } from '../../../hooks/useSettings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { stringWidth } from '../../../ink/stringWidth.js'
import { Ansi, Box, Text, useTheme } from '../../../ink.js'
import { type CliHighlight, getCliHighlightPromise } from '../../../utils/cliHighlight.js'
import { applyMarkdown } from '../../../utils/markdown.js'
import sliceAnsi from '../../../utils/sliceAnsi.js'
import { notBuilt, type Unbuilt } from '../../../pi/holes.js'

type PreviewBoxProps = Unbuilt

export function PreviewBox(props: PreviewBoxProps): React.ReactNode {
  return notBuilt('src/components/permissions/AskUserQuestionPermissionRequest/PreviewBox.tsx:29')
}

function PreviewBoxWithHighlight(props: PreviewBoxProps): React.ReactNode {
  const highlight = use(getCliHighlightPromise()) as CliHighlight | null
  return <PreviewBoxBody {...props} highlight={highlight} />
}

function PreviewBoxBody(arg0: PreviewBoxProps & { highlight: CliHighlight | null }): React.ReactNode {
  return notBuilt('src/components/permissions/AskUserQuestionPermissionRequest/PreviewBox.tsx:46')
}
