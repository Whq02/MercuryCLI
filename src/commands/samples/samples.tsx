import * as React from 'react'
import { SamplesListView } from '../../components/samples/SamplesListView.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async onDone => {
  return <SamplesListView onClose={() => onDone(undefined, { display: 'skip' })} />
}
