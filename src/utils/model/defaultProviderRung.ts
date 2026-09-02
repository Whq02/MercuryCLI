// ============================================================================
//  model/defaultProviderRung — the /defaultprovider owner and the home's
//  LEGACY default-provider record (the neutral-default ruling).
//
//  THE LAW: the default provider is the provider of the MOST RECENT SIGN-IN
//  (utils/model/computedDefault over the sign-in ledger). /defaultprovider
//  is the operator's word that a family is the most recent sign-in: it
//  records an 'operator-switch' entry in the ledger and writes nothing
//  else — the next sign-in moves the default again, as the ruling says.
//
//  The config field `defaultProvider` — written by the first login and by
//  /defaultprovider before the ledger existed — is READ ONLY, as the
//  tiebreak among credentials whose sign-in time was never recorded (a home
//  that gains the ledger keeps the lane it had until its next sign-in). No
//  read path writes it, and nothing writes it any more: set, never
//  heal-repainted — the stored bytes stay whatever they are, and an unknown
//  spelling reads as unset.
// ============================================================================
import { recordSignIn, type SignInLedgerIo } from '../accounts/signInLedger.js'

/** The router family ids this record recognises — mirrors RouterProviderId
 *  (utils/router/providers/types); an unknown stored value reads as unset
 *  (the stored bytes stay untouched — never a heal-repaint). */
const KNOWN_FAMILIES = new Set([
  'anthropic',
  'openai',
  'zai',
  'moonshot',
  'deepseek',
  'openai-compat',
  'openrouter',
  'gemini',
  'huggingface',
  'local',
])

/** Injectable read for provers; production callers pass nothing. */
export interface DefaultProviderReads {
  configuredProvider?: () => string | undefined
}

/** The stored legacy default-provider word, or undefined (absent · unreadable
 *  config · an unknown spelling). The computed default reads it as the
 *  untimed tiebreak only. */
export function configuredDefaultProvider(reads?: DefaultProviderReads): string | undefined {
  try {
    const raw =
      reads?.configuredProvider !== undefined
        ? reads.configuredProvider()
        : (
            require('../config.js') as { getGlobalConfig: () => { defaultProvider?: string } }
          ).getGlobalConfig().defaultProvider
    if (typeof raw !== 'string') return undefined
    const trimmed = raw.trim()
    return KNOWN_FAMILIES.has(trimmed) ? trimmed : undefined
  } catch {
    return undefined
  }
}

/** The one /defaultprovider write — the operator's word that `family` is
 *  the most recent sign-in, recorded in the sign-in ledger. Answers true
 *  when the record landed; false for a family the registry does not know
 *  or a failed write (the command says so). */
export function switchDefaultProvider(family: string, io?: SignInLedgerIo): boolean {
  if (!KNOWN_FAMILIES.has(family)) return false
  return recordSignIn(family, 'operator-switch', io)
}

/** The recognised family ids, for the /defaultprovider picker + arg parse. */
export function knownDefaultProviderFamilies(): readonly string[] {
  return [...KNOWN_FAMILIES]
}
