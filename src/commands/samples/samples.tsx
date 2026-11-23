import { SamplesListView } from '../../screen/samples/SamplesListView.js'
import type { LocalJSXCommandCall } from '../catalogue/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <SamplesListView onClose={() => onDone(undefined, { display: 'skip' })} />
}
