import {
  deriveSecurityFlags,
  getAllCommands,
  getVariablesByScope,
  type ParsedPowerShellCommand,
  type ParsedCommandElement,
} from '../../utils/permissions/decision/commandAnalysis.js'
import { argumentTypeAt } from '../../utils/powershell/parser.js'
import {
  DANGEROUS_SCRIPT_BLOCK_CMDLETS,
  FILEPATH_EXECUTION_CMDLETS,
  MODULE_LOADING_CMDLETS,
} from '../../utils/powershell/dangerousCmdlets.js'
import { resolveToCanonical } from './readOnlyValidation.js'
import { isClmAllowedType } from './clmTypes.js'
import { notBuilt } from '../../pi/holes.js'

type Verdict = { behavior: 'ask' | 'passthrough' | 'allow'; message?: string }
const PASS: Verdict = { behavior: 'passthrough' }
const ASK = (message: string): Verdict => ({ behavior: 'ask', message })

function normArg(arg: string): string {
  return arg.replace(/^[/–—―]/, '-')
}

const PS_EXES = new Set(['pwsh', 'pwsh.exe', 'powershell', 'powershell.exe'])
function isPsExecutable(name: string): boolean {
  const lower = name.toLowerCase()
  return PS_EXES.has(lower) || PS_EXES.has(lower.split(/[\\/]/).pop() ?? lower)
}

function hasParam(element: ParsedCommandElement, full: string, min: string): boolean {
  for (const raw of element.args) {
    let arg = normArg(raw).toLowerCase()
    const colon = arg.indexOf(':', 1)
    if (colon !== -1) arg = arg.slice(0, colon)
    if (arg.startsWith(min) && full.startsWith(arg)) return true
  }
  return false
}

export function powershellCommandIsSafe(_command: string, parsed: ParsedPowerShellCommand): Verdict {
  return notBuilt('src/tools/PowerShellTool/powershellSecurity.ts:41')
}
