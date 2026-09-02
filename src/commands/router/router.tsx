import * as React from 'react'
import { RouterBoard } from '../../components/RouterBoard.js'
import { routerRunStore } from '../../substrate/routerRunStore.js'
import { resetOutcomeHistory, routerOutcomeStore } from '../../substrate/routerOutcomeStore.js'
import {
  isRouterPosture,
  readRouterPostureFile,
  writeRouterPosture,
  type RouterModelPin,
} from '../../utils/router/postures.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

// `/router` args — see index.ts. Argful invocations act immediately and return
// a one-line receipt (the board is the no-arg surface). A posture/pin change
// applies from the NEXT route decision — an in-flight node is never re-routed
// mid-turn (said in the receipt so the timing is never a surprise).

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const parts = (args ?? '').trim().split(/\s+/).filter(Boolean)
  const [head, ...rest] = parts

  if (head && isRouterPosture(head)) {
    const next = writeRouterPosture({ posture: head })
    onDone(
      `router posture → ${next.posture} (persisted; applies from the next route decision — an in-flight node keeps its route)${next.posture === 'fixed' ? ' · nothing routes: the pinned topology' : ''}`,
    )
    return null
  }

  if (head === 'pin') {
    const pin = rest[0]
    if (pin === 'opus' || pin === 'sonnet' || pin === 'auto') {
      const next = writeRouterPosture({ pin: pin as RouterModelPin })
      onDone(
        pin === 'auto'
          ? 'router pin cleared → auto (the policy chooses the class)'
          : `router pin → ${next.pin} (every non-exact-pin node routes to this class; visible as 'operator-pin' in decisions)`,
      )
      return null
    }
    onDone('usage: /router pin opus|sonnet|auto')
    return null
  }

  if (head === 'reset-history') {
    const before = (await routerOutcomeStore().read().catch(() => null))?.rows.length ?? 0
    await resetOutcomeHistory()
    onDone(`router outcome history reset (${before} observation(s) dropped) — routing runs on semantic intent alone until new samples accrue`)
    return null
  }

  if (head === 'explain') {
    const state = await routerRunStore().read().catch(() => null)
    const plan = state?.plans[state.plans.length - 1]
    if (!plan) {
      onDone('no route decision recorded yet — a Scribe/Router dispatch mints the first plan')
      return null
    }
    const d = plan.decision
    const lines = [
      `route ${plan.id} · ${plan.mode} · ${plan.state}`,
      `profile: ${plan.profile} — ${d.displayReasons.join(' · ') || '(no display reasons)'}`,
      `codes: [${d.decisiveReasons.join(', ')}]${d.adjustments.length ? ` · adjusted: [${d.adjustments.join(', ')}]` : ''}`,
      `models: ${d.selectedModels.map(m => `${m.modelClass}:${m.model}@${m.effort}`).join(', ') || '—'}`,
      `source: ${d.source} · posture ${d.posture} · policy ${d.policyVersion}`,
      ...(d.workerAffinity ? [`affinity: ${d.workerAffinity.keptCurrentModel ? 'kept current worker' : 'changed worker'} — ${d.workerAffinity.reason}`] : []),
      ...(d.priorContribution ? [`history: ${d.priorContribution.sampleCount} samples · first-pass ${Math.round(d.priorContribution.acceptedFirstPassRate * 100)}% · capped weight ${d.priorContribution.weight}`] : []),
      ...plan.nodes.map(n => `  ${n.id} ${n.state}${n.attempt > 1 ? ` (attempt ${n.attempt})` : ''} → ${n.assignedWorker ?? '—'} · ${n.assignedModel ? `${n.assignedModel.model}@${n.assignedModel.effort}` : '—'}`),
    ]
    onDone(lines.join('\n'))
    return null
  }

  if (head === 'engines') {
    const { refreshProviderDiscovery, zaiKeySource } = await import(
      '../../utils/router/providerDiscovery.js'
    )
    await Promise.all([refreshProviderDiscovery('openai'), refreshProviderDiscovery('zai')])
    const { buildRouterModelSnapshot } = await import('../../utils/router/modelRegistry.js')
    const snapshot = buildRouterModelSnapshot()
    // The header names the estate as it is (every provider lane beside the
    // home lane, not the two it opened with) and the ruled crew fence.
    const lines: string[] = ['engines — every provider lane beside the home lane; roster seats stay Anthropic (the ruled crew fence)']
    for (const p of snapshot.providers.filter(x => x.id !== 'anthropic')) {
      const d = p.description
      const models = d.catalogue.map(c => c.id).join(', ') || '—'
      // The lane word names its basis: 'available' is the adapter's own
      // status over a PRESENT credential — no probe of the credential's
      // validity runs here (the catalogue source beside it says whether a
      // live fetch has landed).
      lines.push(
        `${p.id}: ${p.available ? 'available (credential present)' : p.reason} · ${d.account.label} · ${d.transport} · models: ${models} (${d.catalogueSource})`,
      )
    }
    const openaiRow = snapshot.providers.find(x => x.id === 'openai')
    if (openaiRow && !openaiRow.available && openaiRow.reason === 'no-account:openai') {
      lines.push(
        'openai: no account source — /logins signs in a ChatGPT subscription (browser PKCE; device code for headless), or set OPENAI_API_KEY',
      )
    }
    // A8: the digest-tied qualification receipts (live settlements only).
    {
      const { readQualificationReceipts } = await import(
        '../../services/providers/openai/qualificationStore.js'
      )
      const receipts = readQualificationReceipts()
      if (receipts.length > 0) {
        const current = receipts.filter(r => r.current)
        const roles = [...new Set(current.map(r => `${r.receipt.role}:${r.receipt.modelId}`))]
        lines.push(
          `gpt qualification receipts: ${current.length} current${receipts.length > current.length ? ` · ${receipts.length - current.length} expired (digest/epoch drift)` : ''}${roles.length ? ` — ${roles.join(' · ')}` : ''}`,
        )
      }
    }
    const source = zaiKeySource()
    lines.push(
      source
        ? `zai key source: ${source}${source === 'env' ? ' (env pin WINS over the store)' : ' (auth-scoped store)'}`
        : 'zai key: none — /router key zai stores one (masked entry)',
    )
    onDone(lines.join('\n'))
    return null
  }

  // OpenAI sign-in/out RETIRED here (operator order): /logins is
  // the ONE login home (browser PKCE + device code both live there) and the
  // /accounts board owns disconnect — a second OAuth surface was the
  // duplication class. The retired arms steer instead of dying silent.
  if (head === 'connect') {
    onDone(
      'OpenAI sign-in moved to /logins → "OpenAI — ChatGPT subscription or API key" (pick the subscription arm; browser sign-in, or press d on the wait for a device code on a headless machine). /router connect is retired.',
    )
    return null
  }

  if (head === 'disconnect') {
    onDone(
      'OpenAI disconnect moved to /accounts — ⌫ on the openai row drops the subscription (a stored API key clears there too).',
    )
    return null
  }

  if (head === 'source') {
    // `/router source [anthropic] sub|api|clear` — the two two-slot
    // families' seat preference in words (the one-key
    // gesture lives on the Logins screen and the /model account surface,
    // all writing the SAME per-family preference doors).
    const anthropicArm = rest[0] === 'anthropic'
    const target = anthropicArm ? rest[1] : rest[0]
    if (anthropicArm) {
      const { readAnthropicPreferredSource, writeAnthropicPreferredSource, isClaudeAISubscriber } =
        await import('../../utils/auth.js')
      const { resetLimitsForCredentialSwitch } = await import('../../services/claudeAiLimits.js')
      if (target === 'sub' || target === 'subscription' || target === 'clear') {
        writeAnthropicPreferredSource(null)
      } else if (target === 'api' || target === 'api-key') {
        writeAnthropicPreferredSource('api-key')
      } else {
        onDone(
          `usage: /router source anthropic sub|api|clear — seats the claude.ai sign-in or the /logins managed key (current preference: ${readAnthropicPreferredSource() ?? 'none — the sign-in wins when connected'})`,
        )
        return null
      }
      // The account behind the Anthropic lane changed — the limits latch
      // and window feeders must not outlive the departed seat.
      resetLimitsForCredentialSwitch()
      // Nor the memoised header set (release-hardening audit rank 49): the
      // next turn resolves its anthropic-beta values and tool schemas under
      // the newly seated credential — the same discipline the slot-switch
      // door applies.
      const { clearBetasCaches } = await import('../../utils/model/capabilities.js')
      const { clearToolSchemaCache } = await import('../../utils/toolSchemaCache.js')
      clearBetasCaches()
      clearToolSchemaCache()
      onDone(
        `preferred Anthropic source → ${readAnthropicPreferredSource() ?? 'cleared (the claude.ai sign-in wins when connected)'} · the wire now bills: ${isClaudeAISubscriber() ? 'the Claude subscription' : 'the API key ladder'} · the next turn rides it`,
      )
      return null
    }
    const { writePreferredOpenaiSource, resolveOpenaiAccount, readPreferredOpenaiSource } =
      await import('../../services/providers/openai/openaiAccounts.js')
    if (target === 'sub' || target === 'subscription') writePreferredOpenaiSource('chatgpt-subscription')
    else if (target === 'api' || target === 'api-key') writePreferredOpenaiSource('api-key')
    else if (target === 'clear') writePreferredOpenaiSource(null)
    else {
      const current = readPreferredOpenaiSource()
      onDone(
        `usage: /router source [anthropic] sub|api|clear — sets the family's preferred account source when both exist (current OpenAI preference: ${current ?? 'none — subscription wins when connected'})`,
      )
      return null
    }
    const preference = readPreferredOpenaiSource()
    const active = resolveOpenaiAccount()
    onDone(
      `preferred OpenAI source → ${preference ?? 'cleared (subscription wins when connected)'} · active resolution: ${active ? active.label : 'none available (connect a subscription via /logins, or set an API key)'}`,
    )
    return null
  }

  if (head === 'key') {
    // Grammar: `/router key [provider] [clear]` —
    // provider ∈ zai (default) · moonshot · deepseek · compat · huggingface ·
    // local · brave · tavily (the two web-search keys — non-model
    // credentials in the same store, services/search). A machine-built
    // `--return=/cmd` token chains that command after the entry settles, so
    // a chooser-routed attach lands back on its origin surface.
    // The door names what it takes: a provider word outside the key lanes
    // refuses and points at that family's own door — it never falls
    // silently to one lane (the operator's ruled refusal sentence sends new
    // users here with ANY provider word).
    const KEY_LANES = ['zai', 'moonshot', 'deepseek', 'compat', 'huggingface', 'local', 'brave', 'tavily'] as const
    const word = rest.find(token => token !== 'clear' && !token.startsWith('--return='))
    if (word !== undefined && !(KEY_LANES as readonly string[]).includes(word)) {
      const loginsFamilies = ['openrouter', 'gemini', 'openai', 'anthropic', 'claude', 'console']
      onDone(
        `/router key takes ${KEY_LANES.join(' · ')} (got '${word}'); ${loginsFamilies.includes(word) ? `${word} keys attach through /logins ${word}` : 'OpenRouter, Gemini, OpenAI and Anthropic keys attach through /logins <family>'}.`,
      )
      return null
    }
    const providerArg = (word ?? 'zai') as (typeof KEY_LANES)[number]
    const returnCommand = rest.find(token => token.startsWith('--return='))?.slice('--return='.length)
    const chain =
      returnCommand !== undefined && returnCommand.startsWith('/')
        ? { nextInput: returnCommand, submitNextInput: true as const }
        : {}
    const clearArg = rest.includes('clear')
    if (clearArg) {
      const secrets = await import('../../utils/router/providerSecrets.js')
      if (providerArg === 'moonshot') {
        secrets.writeStoredMoonshotApiKey(null)
        onDone('Moonshot stored key cleared (an explicit MOONSHOT_API_KEY env pin, if set, still applies).')
      } else if (providerArg === 'deepseek') {
        secrets.writeStoredDeepseekApiKey(null)
        onDone('DeepSeek stored key cleared (an explicit DEEPSEEK_API_KEY env pin, if set, still applies).')
      } else if (providerArg === 'compat') {
        secrets.writeStoredCompatApiKey(null)
        onDone('Custom-endpoint stored key cleared (an explicit MERCURY_COMPAT_API_KEY env pin, if set, still applies).')
      } else if (providerArg === 'huggingface') {
        secrets.writeStoredHuggingfaceApiKey(null)
        onDone('Hugging Face stored token cleared (an explicit HF_TOKEN env pin or an OAuth sign-in, if present, still applies).')
      } else if (providerArg === 'local') {
        secrets.writeStoredLocalApiKey(null)
        onDone('Local-server stored key cleared (an explicit MERCURY_LOCAL_API_KEY env pin, if set, still applies).')
      } else if (providerArg === 'brave') {
        secrets.writeStoredBraveSearchApiKey(null)
        onDone('Brave Search stored key cleared (an explicit BRAVE_API_KEY env pin, if set, still applies); web search falls back to the next open door.')
      } else if (providerArg === 'tavily') {
        secrets.writeStoredTavilyApiKey(null)
        onDone('Tavily stored key cleared (an explicit TAVILY_API_KEY env pin, if set, still applies); web search falls back to the next open door.')
      } else {
        secrets.writeStoredZaiApiKey(null)
        onDone('Z.AI stored key cleared (an explicit ZAI_API_KEY env pin, if set, still applies).')
      }
      return null
    }
    const { RouterKeyEntry } = await import('../../components/RouterKeyEntry.js')
    return <RouterKeyEntry provider={providerArg} onDone={receipt => onDone(receipt, chain)} />
  }

  if (head) {
    onDone(`unknown /router argument '${head}' — usage: /router [adaptive|quality|balanced|fast|fixed | pin opus|sonnet|auto | explain | engines | source sub|api|clear | key [zai|moonshot|deepseek|compat|huggingface|local|brave|tavily] [clear] | reset-history] (OpenAI sign-in lives at /logins; disconnect at /accounts; brave/tavily are web-search keys)`)
    return null
  }

  // Surface the persisted file once so the board's posture line reflects disk truth.
  readRouterPostureFile()
  return (
    <RouterBoard
      onClose={() => {
        onDone(undefined, { display: 'skip' })
      }}
    />
  )
}
