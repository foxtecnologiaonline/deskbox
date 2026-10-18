export const IPC = {
  GET_STATE: 'deskbox:get-state',
  GET_CATALOG: 'deskbox:get-catalog',
  STATE_CHANGED: 'deskbox:state-changed',
  ADD_SERVICE: 'deskbox:add-service',
  REMOVE_SERVICE: 'deskbox:remove-service',
  REORDER_SERVICES: 'deskbox:reorder-services',
  SELECT_SERVICE: 'deskbox:select-service',
  SET_THEME: 'deskbox:set-theme',
  SERVICE_UNREAD: 'deskbox:service-unread',
  ADD_WORKSPACE: 'deskbox:add-workspace',
  REMOVE_WORKSPACE: 'deskbox:remove-workspace',
  SELECT_WORKSPACE: 'deskbox:select-workspace',
  SET_OVERLAY_OPEN: 'deskbox:set-overlay-open',
  OPEN_COMMAND_PALETTE: 'deskbox:open-command-palette',
  GET_MEMORY_USAGE: 'deskbox:get-memory-usage'
} as const
