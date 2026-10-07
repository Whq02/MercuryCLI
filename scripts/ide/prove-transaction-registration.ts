import { check, done } from './transactionProof.js'
const { getAllBaseTools } = await import('../../src/tools.js')
const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')
for (const loop of ['0', '1']) for (const receipts of ['0', '1']) for (const capture of ['0', '1']) {
  process.env.MERCURY_IDE_LOOP = loop
  process.env.MERCURY_CHANGE_RECEIPTS = receipts
  process.env.MERCURY_TX_AUTOCAPTURE = capture
  check(`registration follows loop=${loop}, receipts=${receipts}, capture=${capture}`,
    getAllBaseTools().some(tool => tool.name === 'Transaction') === (loop === '1' && receipts === '1' && capture === '1'))
}
for (const env of ['MERCURY_IDE_LOOP', 'MERCURY_TX_AUTOCAPTURE']) {
  const spec = getFlagSpec(env)
  check(`${env} retains its default-on additive flag metadata`, spec?.kind === 'default-on' && spec.tier === 'additive')
}
done('prove-transaction-registration')
