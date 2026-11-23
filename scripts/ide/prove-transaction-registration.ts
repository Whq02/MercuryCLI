import { check, done } from './transactionProof.js'
const { getAllBaseTools } = await import('../../src/tools/kit/toolList.js')
const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.js')
for (const loop of ['0', '1']) for (const receipts of ['0', '1']) for (const capture of ['0', '1']) {
  process.env.MERCURY_IDE_LOOP = loop
  process.env.MERCURY_CHANGE_RECEIPTS = receipts
  process.env.MERCURY_TX_AUTOCAPTURE = capture
  check(`registration follows loop=${loop}, receipts=${receipts}, capture=${capture}`,
    getAllBaseTools().some(tool => tool.name === 'Transaction') === (loop === '1' && receipts === '1' && capture === '1'),
    'hint: the Transaction tool must be listed by getAllBaseTools in src/tools/kit/toolList.ts only when ideLoopEnabled(), changeTransactionEnabled() and txAutoCaptureEnabled() are all on')
}
for (const env of ['MERCURY_IDE_LOOP', 'MERCURY_TX_AUTOCAPTURE']) {
  const spec = getFlagSpec(env)
  check(`${env} retains its default-on additive flag metadata`, spec?.kind === 'default-on' && spec.tier === 'additive', `${JSON.stringify(spec)}; hint: restore ${env} as a default-on additive flag in the flag registry (FLAG_REGISTRY)`)
}
done('prove-transaction-registration')
