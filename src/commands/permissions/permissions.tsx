import { PermissionRuleList } from '../../permissions/cards/rule-manager/PermissionRuleList.js';
import type { LocalJSXCommandCall } from '../catalogue/command.js';
export const call: LocalJSXCommandCall = async onDone => {
  return <PermissionRuleList onExit={onDone} />;
};
