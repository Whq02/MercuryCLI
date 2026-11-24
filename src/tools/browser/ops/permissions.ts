import { metadataRefusal } from '../../web-fetch/privateHost.js'
import type { ToolUseContext } from '../../kit/tool.js'
import {
  type CheckedTarget,
  MAIN_TAB,
  activeSession,
  attachedBrowser,
  noteCheckedActOrigin,
  originApproved,
  originOf,
  parseAttachEndpoint,
  secretPairingApproved,
} from '../../../integrations/browser/browserSession.js'
import { ownerFromToolUseContext } from '../../../engine/run-owner/resolveOwner.js'
import type { OwnerKey } from '../../../engine/run-owner/ownerKey.js'
import { getRuleByContentsForToolName } from '../../../permissions/rules/permissionDoor.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { suggestionForExactCommand } from '../../../permissions/rules/shellRuleMatching.js'
import { ruleSentence } from '../../../permissions/rules/ruleReason.js'
import { ATTACH_OP, ATTACH_SCOPE_WORDS, ATTACH_SEES } from '../../../integrations/browser/browserWords.js'
import type { PermissionRule, ToolPermissionContext } from '../../../permissions/rules/permissions.js'
import { ACT_OPS, ATTACHED_ASK_OPS, type Input } from './schema.js'
import { CRASH_OPEN_OPS } from './failures.js'
import { sendOrigin, targetOrigin, targetSurface } from './page.js'
import { downloadAct, downloadVia } from './downloads.js'
import { checkedTarget } from './targets.js'
import { fileCount, judgeUploadSources } from './upload.js'

export function sentByEmulation(input: Input): { words: string; headers: boolean; username?: string; secretRef?: string } | null {
  const emulation = input?.emulation as { headers?: unknown; credentials?: unknown } | undefined
  const headers = emulation?.headers !== undefined && emulation.headers !== null
  const credentials = emulation?.credentials !== undefined && emulation.credentials !== null
  if (!headers && !credentials) return null
  const secretRef = credentials ? (emulation!.credentials as { secret?: unknown }).secret : undefined
  const username = credentials ? (emulation!.credentials as { username?: string }).username : undefined
  return {
    words: [headers ? 'extra headers sent on every request, including other origins' : '', credentials ? `basic credentials for ${username}` : ''].filter(Boolean).join(' and '),
    headers,
    username,
    ...(typeof secretRef === 'string' ? { secretRef } : {}),
  }
}

function actDetail(input: Input): string {
  switch (input.op) {
    case 'viewport':
      return ` with ${sentByEmulation(input)?.words ?? 'emulation'}`
    case 'click':
      return ` ${input.selector ?? `(${input.x}, ${input.y})`}`
    case 'type':
      if (input.secretRef !== undefined) return ` secret ${input.secretRef} into ${input.selector ?? '(focused element)'}`
      return ` ${(input.text ?? '').length} chars into ${input.selector ?? '(focused element)'}`
    case 'scroll':
      return ` ${input.selector ?? `by ${input.dy}`}`
    case 'select':
      return ` ${input.selector} ← [${(input.values ?? []).join(', ')}]`
    case 'press':
      return ` ${[...(input.modifiers ?? []), input.key ?? ''].filter(Boolean).join('+')}`
    case 'hover':
      return ` ${input.selector}`
    case 'upload':
      return ` ${(input.files ?? []).length === 1 ? input.files![0] : fileCount((input.files ?? []).length)} to ${input.selector}`
    default:
      return ''
  }
}

export async function checkBrowserPermissions(asked: Input, context: ToolUseContext) {
  const input = downloadAct(asked)
  const refused = input.url === undefined ? null : metadataRefusal(input.url)
  if (refused !== null) return { behavior: 'deny' as const, message: refused, decisionReason: { type: 'other' as const, reason: refused } }
  if (input.op === 'provision') {
    try {
      const { installPlanLines, planBrowserInstall } = await import('../../../integrations/browser/browserInstall.js')
      const plan = await planBrowserInstall(input.buildId)
      const lines = installPlanLines(plan)
      return {
        behavior: 'ask' as const,
        message: `Browser provision: download ${plan.consentLine}`,
        decisionReason: { type: 'other' as const, reason: lines.join('\n') },
        updatedInput: { ...input, buildId: plan.buildId },
      }
    } catch (err) {
      return {
        behavior: 'deny' as const,
        message: `provision cannot plan: ${(err as Error).message} — ask the operator to run /browser install on a connected box, or to install a browser normally`,
        decisionReason: { type: 'other' as const, reason: 'browser provisioning metadata unreachable' },
      }
    }
  }
  const owner = ownerFromToolUseContext((context ?? {}) as { owner?: OwnerKey; agentId?: string })
  const attached = attachedBrowser(owner)
  if (input.op === ATTACH_OP) {
    const endpoint = parseAttachEndpoint(input.endpoint)
    if (endpoint.kind === 'refused') return { behavior: 'deny' as const, message: endpoint.refusal, decisionReason: { type: 'other' as const, reason: endpoint.refusal } }
    if (attached?.endpoint === endpoint.address) return { behavior: 'allow' as const, updatedInput: asked }
    return {
      behavior: 'ask' as const,
      message: `Browser attach: ${endpoint.address} — ${ATTACH_SEES}`,
      decisionReason: { type: 'safetyCheck' as const, reason: ATTACH_SCOPE_WORDS, operatorOnly: true },
    }
  }
  if (attached !== null && downloadVia(asked) !== null) {
    const refusal = `download refused: ${attached.endpoint} is an attached browser and saves its downloads itself, where its user set them to go — nothing was opened or clicked; op:"close" detaches, and the isolated browser follows downloads`
    return { behavior: 'deny' as const, message: refusal, decisionReason: { type: 'other' as const, reason: refusal } }
  }
  const sent = input.op === 'viewport' ? sentByEmulation(input) : null
  if (!ACT_OPS.has(input.op) && sent === null && !(attached !== null && ATTACHED_ASK_OPS.has(input.op))) return { behavior: 'allow' as const, updatedInput: asked }
  const permissionContext = (context as Partial<ToolUseContext> | undefined)?.getAppState?.()
    ?.toolPermissionContext as ToolPermissionContext | undefined
  const ruleFor = (content: string): PermissionRule | null => {
    if (!permissionContext) return null
    for (const behavior of ['deny', 'ask', 'allow'] as const) {
      const rule = getRuleByContentsForToolName(permissionContext, 'Browser', behavior).get(content)
      if (rule) return rule
    }
    return null
  }
  const ruleVerdict = (content: string): 'deny' | 'ask' | 'allow' | null => ruleFor(content)?.ruleBehavior ?? null
  const inTab = input.tab === undefined ? '' : ` in tab ${input.tab}`
  const sources = input.op === 'upload' ? judgeUploadSources(owner, input, permissionContext) : null
  if (sources !== null && 'deny' in sources) return sources.deny
  const sourceAsk = sources === null ? null : sources.ask
  if (input.op === 'open') {
    const target = originOf(input.url ?? '')
    const ruled = ruleVerdict(`origin:${target}`)
    if (ruled === 'deny') {
      return {
        behavior: 'deny' as const,
        message: ruleSentence(`Browsing ${target}`, 'deny', ruleFor(`origin:${target}`)!),
        decisionReason: { type: 'other' as const, reason: `origin:${target} carries a deny rule` },
      }
    }
    if (attached === null ? ruled === 'allow' || (ruled === null && (!target.startsWith('http') || originApproved(owner, target))) : !target.startsWith('http') || originApproved(owner, target)) {
      return { behavior: 'allow' as const, updatedInput: asked }
    }
    if (attached !== null) {
      return {
        behavior: 'ask' as const,
        message: `Browser open: ${input.url ?? '(no url)'}${inTab} — first visit to ${target} this session, in your attached browser (${attached.endpoint}), where you are signed in`,
        decisionReason: { type: 'safetyCheck' as const, reason: `${target} opens in your own browser, with your sign-ins. Yes approves it for this session; every other origin asks before its first read and its first act.`, operatorOnly: true },
      }
    }
    return {
      behavior: 'ask' as const,
      message: `Browser open: ${input.url ?? '(no url)'}${inTab} — first visit to ${target} this session (drives a real headless browser)`,
      suggestions: suggestionForExactCommand('Browser', `origin:${target}`),
    }
  }
  const s = activeSession(owner, input.tab ?? MAIN_TAB)
  if (!s || (s.crashed && !CRASH_OPEN_OPS.has(input.op))) return { behavior: 'allow' as const, updatedInput: asked }
  let origin: string
  let bound: CheckedTarget
  try {
    origin = sent === null ? (await targetOrigin(s, input.frame)) : sendOrigin(s)
    bound = checkedTarget(s, sent === null ? targetSurface(s, input.frame) : s.page)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const originRuled = permissionContext !== undefined && (['deny', 'ask'] as const).some(behavior => [...getRuleByContentsForToolName(permissionContext, 'Browser', behavior).keys()].some(content => content.startsWith('origin:')))
    if (originRuled) return { behavior: 'deny' as const, message, decisionReason: { type: 'other' as const, reason: message } }
    logForDebugging(`browser: the page this ${input.op} targets could not be told (${message}) and no rule names an origin, so the call goes on`)
    return { behavior: 'allow' as const, updatedInput: asked }
  }
  const ruled = ruleVerdict(`origin:${origin}`)
  if (ruled === 'deny') {
    return {
      behavior: 'deny' as const,
      message: ruleSentence(`Browsing ${origin}`, 'deny', ruleFor(`origin:${origin}`)!),
      decisionReason: { type: 'other' as const, reason: `origin:${origin} carries a deny rule` },
    }
  }
  const secret =
    input.op === 'type' && typeof input.secretRef === 'string'
      ? {
          ref: input.secretRef,
          nonWeb: `secret fills only land on real web origins — the page is ${origin} content`,
          nonWebReason: `secret fill refused on non-web scheme ${origin}`,
          deed: `Filling the secret ${input.secretRef} on ${origin}`,
          ask: `Browser fill secret ${input.secretRef} into ${origin}${inTab} (target ${input.selector ?? ''}) — the value never enters the conversation; approve exactly this secret-origin pairing`,
          reason: `filling registered secret ${input.secretRef} into ${origin} needs the operator's own consent for the pairing`,
        }
      : sent?.secretRef !== undefined
        ? {
            ref: sent.secretRef,
            nonWeb: `credentials answer a real web origin only — the page is ${origin} content`,
            nonWebReason: `credentials refused on non-web scheme ${origin}`,
            deed: `Answering ${origin} with the secret ${sent.secretRef}`,
            ask: `Browser answer basic authentication on ${origin}${inTab} with secret ${sent.secretRef} as ${sent.username}${sent.headers ? '; extra headers sent on every request, including other origins' : ''} — the value never enters the conversation; approve exactly this secret-origin pairing`,
            reason: `answering ${origin} with registered secret ${sent.secretRef} needs the operator's own consent for the pairing`,
          }
        : null
  if (secret !== null) {
    if (!origin.startsWith('http')) {
      return {
        behavior: 'deny' as const,
        message: secret.nonWeb,
        decisionReason: { type: 'other' as const, reason: secret.nonWebReason },
      }
    }
    const pairing = `secret:${secret.ref}@${origin}`
    const pairingRuled = ruleVerdict(pairing)
    if (pairingRuled === 'deny') {
      return {
        behavior: 'deny' as const,
        message: ruleSentence(secret.deed, 'deny', ruleFor(pairing)!),
        decisionReason: { type: 'other' as const, reason: `${pairing} carries a deny rule` },
      }
    }
    noteCheckedActOrigin(owner, input.op, origin, bound)
    if (pairingRuled === 'allow' || secretPairingApproved(owner, secret.ref, origin)) {
      return { behavior: 'allow' as const, updatedInput: asked }
    }
    return {
      behavior: 'ask' as const,
      message: secret.ask,
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: secret.reason,
        operatorOnly: true,
      },
      suggestions: suggestionForExactCommand('Browser', pairing),
    }
  }
  const sourcesAsk = {
    behavior: 'ask' as const,
    message: `Browser ${input.op}${actDetail(input)} on ${origin}${inTab} — ${sourceAsk?.message ?? ''}`,
    decisionReason: sourceAsk?.decisionReason,
    suggestions: [],
  }
  if (attached === null ? ruled === 'allow' || (ruled === null && origin.startsWith('http') && originApproved(owner, origin)) : origin.startsWith('http') && originApproved(owner, origin)) {
    noteCheckedActOrigin(owner, input.op, origin, bound)
    return sourceAsk === null ? { behavior: 'allow' as const, updatedInput: asked } : sourcesAsk
  }
  if (!origin.startsWith('http')) {
    if (origin === 'about:' || origin === 'chrome-error:') {
      noteCheckedActOrigin(owner, input.op, origin, bound)
      return sourceAsk === null ? { behavior: 'allow' as const, updatedInput: asked } : sourcesAsk
    }
    noteCheckedActOrigin(owner, input.op, origin, bound)
    if (attached !== null) {
      return {
        behavior: 'ask' as const,
        message: `Browser ${input.op}${actDetail(input)} on a NON-WEB page (${origin})${inTab} of your attached browser — it asks every time${sourceAsk === null ? '' : `\n${sourceAsk.message}`}`,
        decisionReason: { type: 'safetyCheck' as const, reason: `${origin} content is open in your own browser; a page that is not a web origin asks every time.`, operatorOnly: true },
        suggestions: [],
      }
    }
    return {
      behavior: 'ask' as const,
      message: `Browser ${input.op}${actDetail(input)} on a NON-WEB page (${origin})${inTab} — page-conjured content, not an approved web origin${sourceAsk === null ? '' : `\n${sourceAsk.message}`}`,
      decisionReason: {
        type: 'safetyCheck' as const,
        reason: `the top frame is ${origin} content the page itself conjured`,
        operatorOnly: true,
      },
      suggestions: sourceAsk === null ? suggestionForExactCommand('Browser', `origin:${origin}`) : [],
    }
  }
  noteCheckedActOrigin(owner, input.op, origin, bound)
  if (attached !== null) {
    return {
      behavior: 'ask' as const,
      message: `${sent?.headers ? `Browser viewport on ${origin}${inTab} with ${sent.words}` : `Browser ${input.op}${actDetail(input)} on ${origin}${inTab}`} — a tab of your attached browser, with your sign-ins; ${ACT_OPS.has(input.op) || sent !== null ? 'first act' : 'first read'} there, not yet approved this session${sourceAsk === null ? '' : `\n${sourceAsk.message}`}`,
      decisionReason: { type: 'safetyCheck' as const, reason: `${origin} is open in your own browser, with your sign-ins. Yes approves it for this session: Mercury reads and drives its pages without asking again; every other origin asks.`, operatorOnly: true },
      suggestions: [],
    }
  }
  const unloaded = sent !== null && !originOf(s.page.url()).startsWith('http')
  return {
    behavior: 'ask' as const,
    message: `${sent?.headers ? `Browser viewport on ${origin}${inTab} with ${sent.words}` : `Browser ${input.op}${actDetail(input)} on ${origin}${inTab}`} — ${unloaded ? 'its address did not load' : 'reached by navigation'}, not yet approved this session${sourceAsk === null ? '' : `\n${sourceAsk.message}`}`,
    decisionReason: {
      type: 'safetyCheck' as const,
      reason: unloaded ? `${origin} did not load, and no page of it is approved` : `${origin} was reached by navigation, not requested by the operator`,
      operatorOnly: true,
    },
    suggestions: sourceAsk === null ? suggestionForExactCommand('Browser', `origin:${origin}`) : [],
  }
}
