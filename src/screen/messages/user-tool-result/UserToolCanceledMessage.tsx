import { InterruptedByUser } from 'src/screen/messages/InterruptedByUser.js';
import { MessageResponse } from 'src/tools/kit/MessageResponse.js';
export function UserToolCanceledMessage() {
  let t0;
      t0 = <MessageResponse height={1}><InterruptedByUser /></MessageResponse>;
  return t0;
}
