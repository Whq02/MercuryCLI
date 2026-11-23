import { check, done, TransactionTool } from '../ide/transactionProof.js'
import { formatZodValidationError, parameterStandIn } from '../../src/tools/kit/toolErrors.js'

const FORBIDDEN_OPERATIONS = ['begin', 'step', 'resume', 'list']
const FORBIDDEN_FIELDS = ['id', 'intent', 'kind', 'summary', 'refs', 'outcome']
const failure = (input: Record<string, unknown>) => {
  const parsed = TransactionTool.inputSchema.safeParse(input)
  return parsed.success ? 'accepted' : formatZodValidationError('Transaction', parsed.error, TransactionTool.inputSchema)
}
const unknownOperation = failure({ op: 'nonsense-operation' })
for (const op of FORBIDDEN_OPERATIONS) {
  check(`retired operation ${op} is unknown like nonsense`, failure({ op }) === unknownOperation && unknownOperation.includes('"status", "finish"'), `${failure({ op })} — the op enum in inputSchema of src/tools/transaction/TransactionTool.ts must accept only status and finish, with no special refusal for ${op}`)
}
const unknownField = failure({ op: 'status', nonsense: 'value' }).replace('`nonsense`', '`field`')
for (const key of FORBIDDEN_FIELDS) {
  const result = failure({ op: 'status', [key]: 'value' }).replace(`\`${key}\``, '`field`')
  check(`retired field ${key} is unknown like nonsense`, result === unknownField && result.includes('was not expected'), `${result} — inputSchema in src/tools/transaction/TransactionTool.ts must stay a strictObject of op, verdict and unresolved, so ${key} is refused like any unknown field`)
  check(`retired field ${key} has no special refusal`, parameterStandIn('Transaction', key) === undefined, `remove the Transaction entry for ${key} from the stand-in table behind parameterStandIn in src/tools/kit/toolErrors.ts`)
}
check('current operations remain accepted', TransactionTool.inputSchema.safeParse({ op: 'status' }).success &&
  TransactionTool.inputSchema.safeParse({ op: 'finish', verdict: 'completed', unresolved: [] }).success, 'inputSchema in src/tools/transaction/TransactionTool.ts must accept op status and op finish with verdict and unresolved')

done('prove-transaction-inputs-gone')
