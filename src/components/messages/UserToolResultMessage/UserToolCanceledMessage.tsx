import * as React from 'react';
import { InterruptedByUser } from 'src/components/InterruptedByUser.js';
import { MessageResponse } from 'src/components/MessageResponse.js';
export function UserToolCanceledMessage() {
  let t0;
      t0 = <MessageResponse height={1}><InterruptedByUser /></MessageResponse>;
  return t0;
}
