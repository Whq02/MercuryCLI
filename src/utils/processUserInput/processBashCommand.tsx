
import * as React from 'react'
import { Box } from '../../ink.js'
import type { SetToolJSXFn } from '../../Tool.js'
import { BASH_INPUT_TAG } from '../../constants/xml.js'
import { escapeXml } from '../xml.js'
import type { ContentBlockParam } from '../../types/wire.js'
import type { AttachmentMessage, Message, UserMessage } from '../../types/message.js'
import type { ShellProgress } from '../../types/tools.js'
import {
  createAssistantMessage,
  createSyntheticUserCaveatMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
} from '../messages.js'
import { resolveDefaultShell } from '../shell/resolveDefaultShell.js'
import { isPowerShellToolEnabled } from '../shell/shellToolUtils.js'
import { BashTool, type Out } from '../../tools/BashTool/BashTool.tsx'
import { BashModeProgress } from '../../components/BashModeProgress.js'
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

function outputMessage(stdout: string, stderr: string): UserMessage {
  return createUserMessage({
    content: `<${BASH_STDOUT_TAG}>${stdout}</${BASH_STDOUT_TAG}><${BASH_STDERR_TAG}>${escapeXml(stderr)}</${BASH_STDERR_TAG}>`,
  })
}

export async function processBashCommand(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: ProcessUserInputContext,
  setToolJSX: SetToolJSXFn,
  uuid?: string,
): Promise<{ messages: Message[]; shouldQuery: boolean }> {
  const caveat = createSyntheticUserCaveatMessage()
  const commandMessage = echoedCommandMessage(inputString, precedingInputBlocks, uuid)

  const usePowerShell = resolveDefaultShell() === 'powershell' && isPowerShellToolEnabled()
  const tool = usePowerShell
    ? (await import('../../tools/PowerShellTool/PowerShellTool.tsx')).PowerShellTool
    : BashTool

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
      shouldHidePromptInput: false,
      deferIfLocalJSX: true,
    })
  }
  renderDisplay()
  const nestedContext = {
    ...context,
    setToolJSX: (next: Parameters<SetToolJSXFn>[0]) => {
      progressJsx = next?.jsx ?? null
      renderDisplay()
    },
  }

  try {
    const result = await tool.call(
      {
        command: inputString,
        dangerouslyDisableSandbox: true,
      } as never,
      nestedContext as never,
      (async () => ({ behavior: 'allow' as const, updatedInput: {} })) as never,
      createAssistantMessage({ content: `! ${inputString}` }),
      progress => {
        latestProgress = (progress as { data?: ShellProgress }).data ?? latestProgress
        renderDisplay()
      },
    )
    const data = result.data as Out
    return {
      messages: [
        caveat,
        commandMessage,
        ...attachmentMessages,
        outputMessage(data.stdout, data.stderr),
      ],
      shouldQuery: false,
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
        shouldQuery: false,
      }
    }
    if (typeof shellError.stdout === 'string' || typeof shellError.stderr === 'string') {
      return {
        messages: [
          caveat,
          commandMessage,
          ...attachmentMessages,
          outputMessage(shellError.stdout ?? '', shellError.stderr ?? ''),
        ],
        shouldQuery: false,
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
      shouldQuery: false,
    }
  } finally {
    setToolJSX({ jsx: null, shouldHidePromptInput: false, clearUnlessLocalJSX: true })
  }
}
