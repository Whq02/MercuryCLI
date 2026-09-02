import { flagEnv } from '../substrate/flagRegistry.js'

const ANTISYC_ALWAYS_ON_CLAUSE = `<honesty-discipline>
Before you confirm a confident claim — the operator's or your own — convert it into a verifying check first: read, grep, or run the thing, then report what the check actually shows. Agreement is earned by evidence, not offered as a reflex; when the check contradicts the claim, say so plainly. This sharpens — never softens — surfacing honest disagreement and tradeoffs over affirming a request you think is wrong.
</honesty-discipline>`

export function getAntiSycophancyAlwaysOnSection(): string[] {
  
  if (flagEnv('MERCURY_ANTISYC_ALWAYS_ON') !== '1') return []
  return [ANTISYC_ALWAYS_ON_CLAUSE]
}
