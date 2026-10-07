import { check, done, TransactionTool } from '../ide/transactionProof.js'
import { formatZodValidationError, parameterStandIn } from '../../src/utils/toolErrors.js'

const FORBIDDEN_OPERATIONS = ['begin', 'step', 'resume', 'list']
const FORBIDDEN_FIELDS = ['id', 'intent', 'kind', 'summary', 'refs', 'outcome']
const failure = (input: Record<string, unknown>) => {
  const parsed = TransactionTool.inputSchema.safeParse(input)
  return parsed.success ? 'accepted' : formatZodValidationError('Transaction', parsed.error, TransactionTool.inputSchema)
}
const unknownOperation = failure({ op: 'nonsense-operation' })
for (const op of FORBIDDEN_OPERATIONS) {
  check(`retired operation ${op} is unknown like nonsense`, failure({ op }) === unknownOperation && unknownOperation.includes('"status", "finish"'), failure({ op }))
}
const unknownField = failure({ op: 'status', nonsense: 'value' }).replace('`nonsense`', '`field`')
for (const key of FORBIDDEN_FIELDS) {
  const result = failure({ op: 'status', [key]: 'value' }).replace(`\`${key}\``, '`field`')
  check(`retired field ${key} is unknown like nonsense`, result === unknownField && result.includes('was not expected'), result)
  check(`retired field ${key} has no special refusal`, parameterStandIn('Transaction', key) === undefined)
}
check('current operations remain accepted', TransactionTool.inputSchema.safeParse({ op: 'status' }).success &&
  TransactionTool.inputSchema.safeParse({ op: 'finish', verdict: 'completed', unresolved: [] }).success)

done('prove-transaction-inputs-gone')
