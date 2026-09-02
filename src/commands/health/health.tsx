import React from 'react';
import { MercuryHealthCertificate } from './HealthCertificate.js';
import type { LocalJSXCommandCall } from '../../types/command.js';

export const call: LocalJSXCommandCall = (onDone, _context, _args) => {
  return Promise.resolve(<MercuryHealthCertificate onClose={() => onDone()} />);
};
