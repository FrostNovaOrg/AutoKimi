import { Event } from '#/_base/event';
import type {
  IAgentPermissionModeService,
  PermissionModeChangedContext,
} from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';

export function stubPermissionModeService(
  mode: () => PermissionMode,
): IAgentPermissionModeService {
  return {
    _serviceBrand: undefined,
    revision: 0,
    getMode: () => mode(),
    get mode() {
      return mode();
    },
    setMode: () => {},
    setModeAndBroadcast: () => {},
    onDidChangeMode: Event.None as Event<PermissionModeChangedContext>,
  };
}
