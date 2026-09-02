import React from 'react';
import { MercuryHealthCertificate } from './HealthCertificate.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

// /health — ONE truthful surface: the harness health
// certificate (evidence-backed verdict, canonical runAndRecordHealthReport
// facts). There is no second health screen — the certificate rows
// (agent-definitions · env-limits · keybindings
// · version-locks) carry every panel; no false 'Source build' guidance.
// MERCURY_DOCTOR_CERT=0 gates ONLY certificate persistence + --fix (a
// truthful projection of the same report); it can never restore the legacy
// false source-build owner.
export const call: LocalJSXCommandCall = (onDone, _context, _args) => {
  return Promise.resolve(<MercuryHealthCertificate onClose={() => onDone()} />);
};
