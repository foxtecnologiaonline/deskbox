export const IPC = {
  GET_STATE: 'deskbox:get-state',
  GET_CATALOG: 'deskbox:get-catalog',
  STATE_CHANGED: 'deskbox:state-changed',
  ADD_SERVICE: 'deskbox:add-service',
  REMOVE_SERVICE: 'deskbox:remove-service',
  REORDER_SERVICES: 'deskbox:reorder-services',
  SELECT_SERVICE: 'deskbox:select-service',
  SET_THEME: 'deskbox:set-theme',
  SERVICE_UNREAD: 'deskbox:service-unread'
} as const
