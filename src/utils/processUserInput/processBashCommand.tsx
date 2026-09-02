// ============================================================================
//  The `!`-mode path: run the operator's command through the shell tool
//  with live progress UI and fold the result into transcript messages.
//
//  Laws: the shell choice mirrors tool visibility (PowerShell only when it
//  is the resolved default AND the tool gate is open); operator-initiated
//  bang commands run UNSANDBOXED; the formatted standard output is NEVER
//  XML-escaped (it may carry the pipeline's own trusted structural tags),
//  while the raw fallback and the error stream ARE escaped; the progress
//  display clears in all cases; querying is always disabled.
// ============================================================================

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
  // The echoed row is the send's LANDING: it carries the frame uuid (the
  // delivery law's one identity — the cockpit retires its echo on it).
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
  // The formatted stdout is NOT escaped — it may contain the pipeline's own
  // trusted structural tags; stderr IS escaped.
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

  // The input box's routing matches tool visibility: PowerShell only when
  // it is the resolved default shell AND the PowerShell tool is enabled by
  // the same platform/environment gate the tool list uses. The module loads
  // lazily so its large chunk loads only when actually selected.
  const usePowerShell = resolveDefaultShell() === 'powershell' && isPowerShellToolEnabled()
  const tool = usePowerShell
    ? (await import('../../tools/PowerShellTool/PowerShellTool.tsx')).PowerShellTool
    : BashTool

  // The mode's own progress (the shell-mode progress renderer over the
  // latest progress payload) and the tool's own progress element render
  // together; the display is shown immediately and updated on every
  // progress event. The prompt input is NOT hidden — the operator keeps the
  // composer while a foreground shell runs (typing queues behind it).
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
      // A permission/slash dialog that opened over this running command owns
      // the slot; progress renders yield to it instead of clobbering it.
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
        // Operator-initiated bang commands run unsandboxed (the tool checks
        // the "unsandboxed commands allowed" policy).
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
    // Clear this command's own progress display when it ends — but NOT a
    // dialog (permissions/slash) that opened over it while it ran; that
    // dialog survives the command finishing and clears itself.
    setToolJSX({ jsx: null, shouldHidePromptInput: false, clearUnlessLocalJSX: true })
  }
}
