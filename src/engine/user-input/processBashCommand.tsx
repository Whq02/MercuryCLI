
import * as React from 'react'
import { Box } from '../../screen/themedRenderer.js'
import type { SetToolJSXFn } from '../../tools/kit/tool.js'
import { BASH_BACKGROUND_TASK_TAG, BASH_DURATION_MS_TAG, BASH_EXIT_CODE_TAG, BASH_INPUT_TAG } from '../message-shapes/messageTags.js'
import { escapeXml } from '../../platform/text/xml.js'
import type { ContentBlockParam } from '../message-shapes/wire.js'
import type { AttachmentMessage, Message, UserMessage } from '../message-shapes/message.js'
import type { ShellProgress } from '../../tools/kit/toolProgress.js'
import {
  createAssistantMessage,
  createSyntheticUserCaveatMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
} from '../messages/messages.js'
import { resolveDefaultShell } from '../../platform/shell/resolveDefaultShell.js'
import { isPowerShellToolEnabled } from '../../tools/kit/shellTools.js'
import { bashToolAvailable, WINDOWS_BASH_NOTICE } from '../../platform/shell/windowsShellRoad.js'
import { BashTool, type Out } from '../../tools/shell/BashTool.tsx'
import { BashModeProgress } from './BashModeProgress.js'
import type { ProcessUserInputContext } from './processUserInput.js'

const BASH_STDOUT_TAG = 'bash-stdout'
const BASH_STDERR_TAG = 'bash-stderr'

function echoedCommandMessage(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  uuid?: string,
): UserMessage {
  const wrapped = `<${BASH_INPUT_TAG}>${inputString}</${BASH_INPUT_TAG}>`
  if (precedingInputBlocks.length === 0) {
    return createUserMessage({ content: wrapped, ...(uuid ? { uuid } : {}) })
  }
  return createUserMessage({
    content: [...precedingInputBlocks, { type: 'text', text: wrapped } as ContentBlockParam],
    ...(uuid ? { uuid } : {}),
  })
}

type SettledShell = { code: number; durationMs: number }

function settledShell(code: number | undefined, startedAt: number): SettledShell | null {
  return typeof code === 'number' ? { code, durationMs: Math.max(0, Date.now() - startedAt) } : null
}

function outputMessage(stdout: string, stderr: string, settled: SettledShell | null, backgroundTaskId?: string): UserMessage {
  const exit =
    settled === null
      ? ''
      : `<${BASH_EXIT_CODE_TAG}>${settled.code}</${BASH_EXIT_CODE_TAG}><${BASH_DURATION_MS_TAG}>${settled.durationMs}</${BASH_DURATION_MS_TAG}>`
  const background = backgroundTaskId === undefined ? '' : `<${BASH_BACKGROUND_TASK_TAG}>${escapeXml(backgroundTaskId)}</${BASH_BACKGROUND_TASK_TAG}>`
  return createUserMessage({
    content: `<${BASH_STDOUT_TAG}>${stdout}</${BASH_STDOUT_TAG}><${BASH_STDERR_TAG}>${escapeXml(stderr)}</${BASH_STDERR_TAG}>${exit}${background}`,
  })
}

export async function processBashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: string,
): Promise<{ messages: Message[]; shouldStartTurn: boolean }> {
  const caveat = createSyntheticUserCaveatMessage()
  const commandMessage = echoedCommandMessage(inputString, precedingInputBlocks, uuid)

  const usePowerShell = resolveDefaultShell() === 'powershell' && isPowerShellToolEnabled()
  const tool = usePowerShell
    ? (await import('../../tools/powershell/PowerShellTool.tsx')).PowerShellTool
    : BashTool

  if (!usePowerShell && !bashToolAvailable()) {
    return {
      messages: [
        caveat,
        commandMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<${BASH_STDERR_TAG}>${escapeXml(`Command refused: ${WINDOWS_BASH_NOTICE}`)}</${BASH_STDERR_TAG}>`,
        }),
      ],
      shouldStartTurn: false,
    }
  }

  let latestProgress: ShellProgress | null = null
  let progressJsx: React.ReactNode = null
  const renderDisplay = (): void => {
    setToolJSX({
      jsx: (
        <Box flexDirection="column">
          <BashModeProgress input={inputString} progress={latestProgress} verbose={context.options.verbose} />
          {progressJsx}
        </Box>
      ),
      shouldHideComposer: false,
      deferIfLocalJSX: true,
    })
  }
  renderDisplay()
  const nestedContext = {
    ...context,
    toolUseId: commandMessage.uuid,
    shellInputId: commandMessage.uuid,
    setToolJSX: (next: Parameters<SetToolJSXFn>[0]) => {
      progressJsx = next?.jsx ?? null
      renderDisplay()
    },
  }

  const startedAt = Date.now()
  try {
    const result = await tool.call(
      { command: inputString },
      nestedContext,
      async () => ({ behavior: 'allow' as const, updatedInput: {} }),
      createAssistantMessage({ content: `! ${inputString}` }),
      (progress: { toolUseID: string; data: ShellProgress }) => {
        latestProgress = progress.data ?? latestProgress
        renderDisplay()
      },
    )
    const data = result.data as Out
    return {
      messages: [
        caveat,
        commandMessage,
        ...attachmentMessages,
        outputMessage(data.stdout, data.stderr, settledShell(data.code, startedAt), data.backgroundTaskId),
      ],
      shouldStartTurn: false,
    }
  } catch (error) {
    const shellError = error as Partial<Out> & { message?: string }
    if (shellError.interrupted) {
      return {
        messages: [
          caveat,
          commandMessage,
          createUserMessage({ content: INTERRUPT_MESSAGE }),
          ...attachmentMessages,
        ],
        shouldStartTurn: false,
      }
    }
    if (typeof shellError.stdout === 'string' || typeof shellError.stderr === 'string') {
      return {
        messages: [
          caveat,
          commandMessage,
          ...attachmentMessages,
          outputMessage(shellError.stdout ?? '', shellError.stderr ?? '', settledShell(shellError.code, startedAt)),
        ],
        shouldStartTurn: false,
      }
    }
    return {
      messages: [
        caveat,
        commandMessage,
        ...attachmentMessages,
        createUserMessage({
          content: `<${BASH_STDERR_TAG}>${escapeXml(`Command failed: ${String(shellError.message ?? error)}`)}</${BASH_STDERR_TAG}>`,
        }),
      ],
      shouldStartTurn: false,
    }
  } finally {
    setToolJSX({ jsx: null, shouldHideComposer: false, clearUnlessLocalJSX: true })
  }
}
