import { writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { loginFamilyRows, keyPageLine, type KeyFamilyValue } from '../../components/loginFamilyRows.js'
import { deriveFamilySlotGroups, executeSlotRemoval, type AccountSlot } from '../../services/providers/accountSlots.js'
import { readCatalogueIfPending } from '../../services/providers/catalogueOnDemand.js'
import { configuredCompatEndpoints } from '../../services/providers/openaicompat/compatAccounts.js'
import { storeCompatApiKeyLogin } from '../../services/providers/openaicompat/compatLogin.js'
import { providerDisplayName, PROVIDER_ID_SPACES } from '../../services/providers/routeLaw.js'
import { storeCerebrasApiKeyLogin } from '../../services/providers/cerebras/cerebrasLogin.js'
import { storeCohereApiKeyLogin } from '../../services/providers/cohere/cohereLogin.js'
import { storeFireworksApiKeyLogin } from '../../services/providers/fireworks/fireworksLogin.js'
import { storeGroqApiKeyLogin } from '../../services/providers/groq/groqLogin.js'
import { storeDeepseekApiKeyLogin } from '../../services/providers/deepseek/deepseekLogin.js'
import { storeGeminiApiKeyLogin } from '../../services/providers/gemini/geminiLogin.js'
import { runHuggingfaceDeviceLogin, storeHuggingfaceTokenLogin } from '../../services/providers/huggingface/huggingfaceLogin.js'
import { runMetaDeviceLogin, storeMetaApiKeyLogin } from '../../services/providers/meta/metaLogin.js'
import { storeMinimaxApiKeyLogin } from '../../services/providers/minimax/minimaxLogin.js'
import { storeMistralApiKeyLogin } from '../../services/providers/mistral/mistralLogin.js'
import { runKimiDeviceLogin, storeMoonshotApiKeyLogin } from '../../services/providers/moonshot/moonshotLogin.js'
import { runNousDeviceLogin, storeNousApiKeyLogin } from '../../services/providers/nous/nousLogin.js'
import { storeOpenaiApiKeyLogin } from '../../services/providers/openai/openaiLogin.js'
import { storeOpenrouterApiKeyLogin } from '../../services/providers/openrouter/openrouterLogin.js'
import { runQwenDeviceLogin, storeQwenApiKeyLogin } from '../../services/providers/qwen/qwenLogin.js'
import { storeTogetherApiKeyLogin } from '../../services/providers/together/togetherLogin.js'
import { runXaiDeviceLogin, storeXaiApiKeyLogin } from '../../services/providers/xai/xaiLogin.js'
import { storeZaiApiKeyLogin } from '../../services/providers/zai/zaiLogin.js'
import { storeZenApiKeyLogin } from '../../services/providers/zen/zenLogin.js'
import { saveApiKey } from '../../utils/auth.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { authLogin, authLogout, authStatus } from './auth.js'

export const TERMINAL_AUTH_FAMILIES = [
  'anthropic',
  ...PROVIDER_ID_SPACES.map(space => space.route).filter(route => route !== 'local' && route !== 'openai-compat'),
] as const

export function validTerminalAuthFamilies(): string[] {
  const namedCompat = configuredCompatEndpoints().filter(endpoint => endpoint.named).map(endpoint => `compat/${endpoint.name}`)
  return [...TERMINAL_AUTH_FAMILIES, 'openai-compat', 'compat', ...namedCompat]
}

export function normalizeTerminalAuthFamily(raw: string): string | undefined {
  const lowered = raw.trim().toLowerCase()
  if (!lowered) return undefined
  if (lowered === 'claude' || lowered === 'claudeai' || lowered === 'console') return 'anthropic'
  if (lowered === 'kimi') return 'moonshot'
  if (lowered === 'glm') return 'zai'
  if (lowered === 'grok') return 'xai'
  if (lowered === 'muse') return 'meta'
  if (lowered === 'compat') return 'openai-compat'
  if (lowered.startsWith('compat/')) {
    const name = lowered.slice('compat/'.length)
    if (name === 'default') return 'openai-compat'
    return configuredCompatEndpoints().some(endpoint => endpoint.name === name) ? `compat/${name}` : undefined
  }
  if ((TERMINAL_AUTH_FAMILIES as readonly string[]).includes(lowered) || lowered === 'openai-compat') return lowered
  return undefined
}

export function unknownAuthFamilyMessage(raw: string): string {
  return `Unknown provider family '${raw.trim()}'. Known families: ${validTerminalAuthFamilies().join(', ')}.`
}

export async function promptSecretWithoutEcho(promptText: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stderr): Promise<string> {
  if (!(input as { isTTY?: boolean }).isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of input) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
    }
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]?.trim() ?? ''
  }
  output.write(promptText)
  return new Promise<string>(resolve => {
    const rl = createInterface({ input, output, terminal: true })
    ;(rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput = (str: string) => {
      if (str.includes('\n') || str.includes('\r')) output.write('\n')
    }
    rl.question('', answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

export interface ProviderAuthIo {
  key?: string
  mode?: 'key' | 'device' | 'oauth' | 'coding'
  region?: 'global' | 'mainland-cn'
  promptKey?: (promptText: string) => Promise<string>
  writeOut?: (text: string) => void
  writeErr?: (text: string) => void
  exit?: (code: number) => void
}

function defaultWriteOut(text: string): void {
  try { writeSync(1, text) } catch {}
}

function defaultWriteErr(text: string): void {
  try { writeSync(2, text) } catch {}
}

export async function providerAuthLogin(
  familyRaw?: string,
  opts: { email?: string; sso?: boolean; console?: boolean; key?: string; device?: boolean; coding?: boolean; region?: 'global' | 'mainland-cn' } = {},
  io: ProviderAuthIo = {},
): Promise<{ ok: boolean; code: number; receipt: string }> {
  const out = io.writeOut ?? defaultWriteOut
  const err = io.writeErr ?? defaultWriteErr
  const finish = (ok: boolean, receipt: string, code = ok ? 0 : 1): { ok: boolean; code: number; receipt: string } => {
    if (ok) out(`${receipt}\n`)
    else err(`${receipt}\n`)
    io.exit?.(code)
    return { ok, code, receipt }
  }

  if (!familyRaw || familyRaw.trim() === '') {
    await authLogin(opts)
    return { ok: true, code: 0, receipt: 'Signed in' }
  }

  const normalized = normalizeTerminalAuthFamily(familyRaw)
  if (!normalized) {
    return finish(false, unknownAuthFamilyMessage(familyRaw), 1)
  }

  if (normalized === 'anthropic') {
    const providedKey = io.key ?? opts.key
    if (providedKey !== undefined) {
      await saveApiKey(providedKey.trim())
      return finish(true, 'Anthropic API key stored.')
    }
    await authLogin(opts)
    return { ok: true, code: 0, receipt: 'Signed in' }
  }

  const mode = io.mode ?? (opts.device ? 'device' : opts.coding ? 'coding' : undefined)
  if (mode === 'device') {
    if (normalized === 'huggingface') {
      const outcome = await runHuggingfaceDeviceLogin({
        onEvent: ev => {
          if (ev.phase === 'waiting' && ev.polls === 0) out(`Visit ${ev.start.verificationUri} and enter code ${ev.start.userCode}\n`)
        },
      })
      if (outcome.ok) await readCatalogueIfPending('huggingface', { force: true })
      return finish(outcome.ok, outcome.receipt)
    }
    if (normalized === 'moonshot') {
      const outcome = await runKimiDeviceLogin({
        region: io.region ?? opts.region ?? 'global',
        onEvent: ev => {
          if (ev.phase === 'waiting' && ev.polls === 0) out(`Visit ${ev.start.verificationUri} and enter code ${ev.start.userCode}\n`)
        },
      })
      if (outcome.ok) await readCatalogueIfPending('moonshot', { force: true })
      return finish(outcome.ok, outcome.receipt)
    }
    if (normalized === 'xai') {
      const outcome = await runXaiDeviceLogin({
        onEvent: ev => {
          if (ev.phase === 'waiting' && ev.polls === 0) out(`Visit ${ev.start.verificationUri} and enter code ${ev.start.userCode}\n`)
        },
      })
      if (outcome.ok) await readCatalogueIfPending('xai', { force: true })
      return finish(outcome.ok, outcome.receipt)
    }
    if (normalized === 'meta') {
      const outcome = await runMetaDeviceLogin({
        onEvent: ev => {
          if (ev.phase === 'waiting' && ev.polls === 0) out(`Visit ${ev.start.verificationUri} and enter code ${ev.start.userCode}\n`)
        },
      })
      if (outcome.ok) await readCatalogueIfPending('meta', { force: true })
      return finish(outcome.ok, outcome.receipt)
    }
    if (normalized === 'nous') {
      const outcome = await runNousDeviceLogin({
        onEvent: ev => {
          if (ev.phase === 'waiting' && ev.polls === 0) out(`Visit ${ev.start.verificationUri} and enter code ${ev.start.userCode}\n`)
        },
      })
      if (outcome.ok) await readCatalogueIfPending('nous', { force: true })
      return finish(outcome.ok, outcome.receipt)
    }
    if (normalized === 'qwen') {
      const outcome = await runQwenDeviceLogin({
        onEvent: ev => {
          if (ev.phase === 'waiting' && ev.polls === 0) out(`Visit ${ev.start.verificationUriComplete ?? ev.start.verificationUri} and enter code ${ev.start.userCode}\n`)
        },
      })
      if (outcome.ok) await readCatalogueIfPending('qwen', { force: true })
      return finish(outcome.ok, outcome.receipt)
    }
  }

  const promptFn = io.promptKey ?? (text => promptSecretWithoutEcho(text))
  const label = normalized.startsWith('compat/')
    ? normalized
    : providerDisplayName(normalized)
  const guide = !normalized.startsWith('compat') && normalized !== 'openai-compat'
    ? `${keyPageLine(normalized as KeyFamilyValue)}\n`
    : ''
  const rawKey = io.key ?? opts.key ?? (await promptFn(`${guide}Enter ${label} API key: `))
  const key = rawKey.trim()
  if (!key) {
    return finish(false, `No ${label} API key entered — nothing stored.`, 1)
  }

  if (normalized === 'openai-compat' || normalized.startsWith('compat/')) {
    const endpointName = normalized === 'openai-compat' ? 'default' : normalized.slice('compat/'.length)
    const outcome = await storeCompatApiKeyLogin(endpointName, key)
    if (outcome.ok) await readCatalogueIfPending('openai-compat', { force: true })
    return finish(outcome.ok, outcome.receipt)
  }

  let outcome: { ok: boolean; receipt: string }
  switch (normalized) {
    case 'openai':
      outcome = await storeOpenaiApiKeyLogin(key)
      break
    case 'openrouter':
      outcome = await storeOpenrouterApiKeyLogin(key)
      break
    case 'gemini':
      outcome = await storeGeminiApiKeyLogin(key)
      break
    case 'huggingface':
      outcome = await storeHuggingfaceTokenLogin(key)
      break
    case 'moonshot':
      outcome = await storeMoonshotApiKeyLogin(key)
      break
    case 'zai':
      outcome = storeZaiApiKeyLogin(key, mode === 'coding' ? 'coding' : 'general')
      break
    case 'deepseek':
      outcome = await storeDeepseekApiKeyLogin(key)
      break
    case 'xai':
      outcome = await storeXaiApiKeyLogin(key)
      break
    case 'meta':
      outcome = await storeMetaApiKeyLogin(key)
      break
    case 'mistral':
      outcome = await storeMistralApiKeyLogin(key)
      break
    case 'nous':
      outcome = await storeNousApiKeyLogin(key)
      break
    case 'zen':
      outcome = await storeZenApiKeyLogin(key)
      break
    case 'minimax':
      outcome = await storeMinimaxApiKeyLogin(key)
      break
    case 'together':
      outcome = await storeTogetherApiKeyLogin(key)
      break
    case 'cohere':
      outcome = await storeCohereApiKeyLogin(key)
      break
    case 'groq':
      outcome = await storeGroqApiKeyLogin(key)
      break
    case 'cerebras':
      outcome = await storeCerebrasApiKeyLogin(key)
      break
    case 'fireworks':
      outcome = await storeFireworksApiKeyLogin(key)
      break
    case 'qwen':
      outcome = await storeQwenApiKeyLogin(key)
      break
    default:
      return finish(false, unknownAuthFamilyMessage(familyRaw), 1)
  }
  if (outcome.ok) await readCatalogueIfPending(normalized, { force: true })
  return finish(outcome.ok, outcome.receipt)
}

function allAccountSlots(): AccountSlot[] {
  return deriveFamilySlotGroups().flatMap(group => group.slots)
}

export async function providerAuthList(opts: { json?: boolean } = {}, io: ProviderAuthIo = {}): Promise<{ code: number; rows: Array<{ id: string; name: string; label: string; signedIn: boolean; source: string }> }> {
  const out = io.writeOut ?? defaultWriteOut
  const slots = allAccountSlots()
  const rows = loginFamilyRows({ engineLegs: true }).map(row => {
    const familyId = row.value === 'claudeai' || row.value === 'console' ? 'anthropic' : row.value.startsWith('compat/') ? 'openai-compat' : row.value
    const familySlots = slots.filter(slot => slot.family === familyId && (row.value.startsWith('compat/') ? slot.id.includes(row.value.slice('compat/'.length)) : true))
    const signedIn = familySlots.some(slot => slot.signedIn)
    const active = familySlots.find(slot => slot.active && slot.signedIn) ?? familySlots.find(slot => slot.signedIn)
    return {
      id: row.value === 'claudeai' ? 'anthropic' : row.value,
      name: row.label.split(' — ')[0] ?? row.value,
      label: row.label,
      signedIn,
      source: active ? `${active.kindLabel} (${active.identity})` : 'not signed in',
    }
  }).filter((row, index, all) => all.findIndex(other => other.id === row.id) === index)

  if (opts.json) {
    out(`${jsonStringify({ families: rows }, undefined, 2)}\n`)
  } else {
    for (const row of rows) {
      out(`${row.id}: ${row.signedIn ? `signed in — ${row.source}` : 'not signed in'}\n`)
    }
  }
  io.exit?.(0)
  return { code: 0, rows }
}

export async function providerAuthStatus(familyRaw?: string, opts: { json?: boolean } = {}, io: ProviderAuthIo = {}): Promise<{ code: number }> {
  const out = io.writeOut ?? defaultWriteOut
  const err = io.writeErr ?? defaultWriteErr
  if (!familyRaw || familyRaw.trim() === '') {
    await authStatus(opts)
    return { code: 0 }
  }
  const normalized = normalizeTerminalAuthFamily(familyRaw)
  if (!normalized) {
    const msg = unknownAuthFamilyMessage(familyRaw)
    err(`${msg}\n`)
    io.exit?.(1)
    return { code: 1 }
  }
  const targetFamily = normalized.startsWith('compat/') ? 'openai-compat' : normalized
  const endpointFilter = normalized.startsWith('compat/') ? normalized.slice('compat/'.length) : undefined
  const familySlots = allAccountSlots().filter(
    slot => slot.family === targetFamily && (endpointFilter === undefined || slot.id.includes(endpointFilter)),
  )
  const signedIn = familySlots.some(slot => slot.signedIn)
  if (opts.json) {
    out(
      `${jsonStringify(
        {
          family: normalized,
          signedIn,
          slots: familySlots.map(slot => ({
            id: slot.id,
            kind: slot.kind,
            kindLabel: slot.kindLabel,
            identity: slot.identity,
            active: slot.active,
            signedIn: slot.signedIn,
            ...(slot.stateNote ? { stateNote: slot.stateNote } : {}),
          })),
        },
        undefined,
        2,
      )}\n`,
    )
  } else if (familySlots.length === 0 || !signedIn) {
    out(`${normalized}: not signed in\n`)
  } else {
    for (const slot of familySlots.filter(s => s.signedIn)) {
      out(`${normalized}: ${slot.kindLabel} — ${slot.identity}${slot.active ? ' (active)' : ''}${slot.stateNote ? ` · ${slot.stateNote}` : ''}\n`)
    }
  }
  const code = signedIn ? 0 : 1
  io.exit?.(code)
  return { code }
}

export async function providerAuthLogout(familyRaw?: string, io: ProviderAuthIo = {}): Promise<{ ok: boolean; code: number; receipt: string }> {
  const out = io.writeOut ?? defaultWriteOut
  const err = io.writeErr ?? defaultWriteErr
  if (!familyRaw || familyRaw.trim() === '') {
    await authLogout()
    return { ok: true, code: 0, receipt: 'Signed out' }
  }
  const normalized = normalizeTerminalAuthFamily(familyRaw)
  if (!normalized) {
    const msg = unknownAuthFamilyMessage(familyRaw)
    err(`${msg}\n`)
    io.exit?.(1)
    return { ok: false, code: 1, receipt: msg }
  }
  const targetFamily = normalized.startsWith('compat/') ? 'openai-compat' : normalized
  const endpointFilter = normalized.startsWith('compat/') ? normalized.slice('compat/'.length) : undefined
  const familySlots = allAccountSlots().filter(
    slot => slot.family === targetFamily && (endpointFilter === undefined || slot.id.includes(endpointFilter)),
  )
  const removable = familySlots.filter(slot => slot.signedIn && slot.removal.route !== 'env' && slot.removal.route !== 'settings' && slot.removal.route !== 'excluded')
  if (removable.length === 0) {
    const envSlot = familySlots.find(slot => slot.removal.route === 'env')
    const note = envSlot && envSlot.removal.route === 'env'
      ? `${envSlot.removal.envVar} is set in the environment — unset it in your shell; no stored ${normalized} credential to remove.`
      : `No stored ${normalized} credential to sign out.`
    out(`${note}\n`)
    io.exit?.(0)
    return { ok: true, code: 0, receipt: note }
  }
  const notes: string[] = []
  for (const slot of removable) {
    const outcome = executeSlotRemoval(slot)
    notes.push(outcome.note)
  }
  const receipt = notes.join(' ')
  out(`${receipt}\n`)
  io.exit?.(0)
  return { ok: true, code: 0, receipt }
}
