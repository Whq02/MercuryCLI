// ============================================================================
//  utils/cockpit/helmConsoleAsk — the Helm console's ask engine.
//
//  One function: turn a console question into a /btw-grade side question —
//  the SAME hardened fork (runSideQuestion: tool-denied, 1 turn, cache-hit
//  prefix, skip-cache-write, real abort) — from a live ProcessUserInputContext
//  instead of a command invocation.
//
//  THE CONSOLE'S MODEL IS THE OPERATOR'S PICK: the
//  console container resolves env pin > saved /submodels pick > UNSET. An
//  unset console answers exactly the /submodels hint — no context work, no
//  fork, no model call, no activity stamp — so the hint paints where the
//  answer would be at zero cost.
//
//  THE CONSOLE'S IDENTITY AND ROLE ride the question's framing (the user
//  turn's system-reminder), never the system prompt: the fork keeps the
//  MAIN agent's system prompt + context byte-identical for the cache-hit
//  prefix, and that prompt describes the main agent — so the framing states,
//  as harness-stamped facts, which engine the console runs on
//  (subModelIdentityLine) and what the console's job is (CONSOLE_ROLE):
//  it answers questions about the session and the project from the shared
//  context, never claims the main agent's work as its own, runs no tools.
//
//  Cache-safe params come from getLastCacheSafeParams() (the stopHooks capture
//  — byte-identical prefix ⇒ prompt-cache hit) paired with the FRESH context
//  and messages, exactly the btw.tsx recipe. On a virgin session (no completed
//  turn yet) the prefix is rebuilt from scratch; those builders live behind
//  DYNAMIC imports so this file adds no component-layer static edge into
//  constants/prompts.ts / context.ts (the queryContext.ts cycle rule).
// ============================================================================

import type { Message } from '../../types/message.js'
import { API_ERROR_MESSAGE_PREFIX } from '../../services/api/errors.js'
import type { CacheSafeParams } from '../forkedAgent.js'
import { getLastCacheSafeParams } from '../forkedAgent.js'
import { getMessagesAfterCompactBoundary } from '../messages.js'
import {
  consoleModelOverride,
  resolveSubModel,
  subModelIdentityLine,
  type SubModelPin,
} from '../model/subModelSlots.js'
import type { ProcessUserInputContext } from '../processUserInput/processUserInput.js'
import { runSideQuestion } from '../sideQuestion.js'
import { noteCritterRealActivity } from './critterSleep.js'
import { asSystemPrompt } from '../systemPromptType.js'
import type { ConsoleRunnerResult } from './helmConsole.js'

/** The console's role, stated to the model as the harness's words. The
 *  system prompt and the shared context belong to the MAIN agent; these
 *  sentences keep the console from speaking as it. */
export const CONSOLE_ROLE =
  `You are the Mercury CONSOLE: a separate side-question assistant that answers the operator's questions ABOUT this session and this project. ` +
  `You are not Mercury's main agent — the system prompt and the conversation above are the main agent's, shared with you as read-only context. ` +
  `The main agent did that work and continues independently: describe it as the main agent's work, never as your own, and do not present yourself as interrupted or refer to what you were "previously doing". ` +
  `You have no tools: you cannot read files, run commands, search, or take any action, and there is no follow-up turn — never promise to act or offer to look something up. ` +
  `Answer directly, in a single response, from what is already in the context; if you do not know, say so. ` +
  `When asked what your job or role is, say exactly this: you are the console, answering questions about the session and the project.`

/** The framing a console question rides with: the engine-identity fact
 *  line for the resolved pin, then the role. Exported so a prover can pin
 *  the identity line against the resolved slot without running a fork. */
export function consoleAskFraming(pin: SubModelPin): string {
  return `${subModelIdentityLine('console', pin)}\n${CONSOLE_ROLE}`
}

/** The side-question engine hands a wire/API failure back as answer TEXT
 *  (the /btw fallback, which has no other channel). The console has an
 *  error state, so a failed ask must never read as an answer with a 0→0
 *  receipt: this names the failure, or null for a real answer. */
export function consoleAskFailure(response: string | null): string | null {
  if (response === null) return null
  const text = response.trimStart()
  if (text.startsWith(API_ERROR_MESSAGE_PREFIX) || text.startsWith('An API error occurred')) return text
  return null
}

/** Same guard as btw.tsx — the console can ask MID-TURN (that's the point),
 *  so a streaming assistant tail must never enter Mercury context. */
function stripInProgressAssistantMessage(messages: Message[]): Message[] {
  const last = messages.at(-1)
  if (last?.type === 'assistant' && last.message.stop_reason === null) {
    return messages.slice(0, -1)
  }
  return messages
}

export async function runConsoleAsk({
  question,
  context,
  abortController,
  originRef,
}: {
  question: string
  context: ProcessUserInputContext
  abortController: AbortController
  /** Parentage: where the ask branched from — threaded
   *  into the engine and back onto the console's own history entry. */
  originRef?: string
}): Promise<ConsoleRunnerResult> {
  // The slot decides FIRST: an unset console answers the hint before any
  // context is read or any prefix built — nothing below runs, nothing is
  // spent, and no usage rides the entry (there is none to report).
  const slot = resolveSubModel('console')
  if (slot.origin === 'unset') {
    return {
      response: slot.hint,
      ...(originRef !== undefined ? { originRef } : {}),
    }
  }
  const forkContextMessages = getMessagesAfterCompactBoundary(
    stripInProgressAssistantMessage(context.messages),
  )
  const saved = getLastCacheSafeParams()
  let cacheSafeParams: CacheSafeParams
  if (saved) {
    cacheSafeParams = {
      systemPrompt: saved.systemPrompt,
      userContext: saved.userContext,
      systemContext: saved.systemContext,
      toolUseContext: context,
      forkContextMessages,
    }
  } else {
    const [{ getSystemPrompt }, { getSystemContext, getUserContext }] =
      await Promise.all([
        import('../../constants/prompts.js'),
        import('../../context.js'),
      ])
    const [rawSystemPrompt, userContext, systemContext] = await Promise.all([
      getSystemPrompt(
        context.options.tools,
        context.options.mainLoopModel,
        [],
        context.options.mcpClients,
      ),
      getUserContext(),
      getSystemContext(),
    ])
    cacheSafeParams = {
      systemPrompt: asSystemPrompt(rawSystemPrompt),
      userContext,
      systemContext,
      toolUseContext: context,
      forkContextMessages,
    }
  }
  const modelOverride = consoleModelOverride(context.options.mainLoopModel)
  // A console ask is a real model turn — wake the critter at dispatch and
  // refresh the stamp at settle (the sleep grace counts from the turn's
  // end, mirroring the session turn's lastTurnEndTs semantics).
  noteCritterRealActivity()
  let result: Awaited<ReturnType<typeof runSideQuestion>>
  try {
    result = await runSideQuestion({
      question,
      cacheSafeParams,
      abortController,
      framing: consoleAskFraming(slot),
      ...(originRef !== undefined ? { originRef } : {}),
      ...(modelOverride !== undefined ? { modelOverride } : {}),
    })
  } finally {
    noteCritterRealActivity()
  }
  const failure = consoleAskFailure(result.response)
  if (failure !== null) throw new Error(failure)
  return {
    response: result.response,
    usage: result.usage,
    ...(result.originRef !== undefined ? { originRef: result.originRef } : {}),
  }
}
