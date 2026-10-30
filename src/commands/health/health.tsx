import { CommandPopupLease } from '../../components/CommandPopupSlot.js';
import { claimCommandPopup } from '../../utils/cockpit/commandPopup.js';
import { MercuryHealthCertificate, healthPopupShape } from './HealthCertificate.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

export const call: LocalJSXCommandCall = (onDone, _context, _args) => {
  const token = claimCommandPopup(healthPopupShape());
  return Promise.resolve(
    <CommandPopupLease token={token}>
      <MercuryHealthCertificate onClose={() => onDone()} />
    </CommandPopupLease>,
  );
};
