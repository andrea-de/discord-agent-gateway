const CUSTOM_IDS = {
  GATEWAY: {
    INFO: 'gateway:info',
    SESSIONS: 'gateway:sessions',
    OPEN_PROJECT: (gateway, project) => `gateway:open-project:${gateway}:${project}`
  },
  PROJECT: {
    START_TOOL: (gateway, tool) => `gateway-project:${gateway}:start:${tool}`,
    HISTORY: (gateway) => `gateway-project:${gateway}:history`,
    README: (gateway) => `gateway-project:${gateway}:readme`,
    FILES: (gateway) => `gateway-project:${gateway}:files`,
    GIT: (gateway) => `gateway-project:${gateway}:git`,
    CLEAN: (gateway) => `gateway-project:${gateway}:clean`,
  },
  THREAD: {
    CONFIRM_DELETE: 'thread:confirm-delete',
    CANCEL_DELETE: 'thread:cancel-delete'
  },
  SESSION: {
    DELETE: (id) => `session:delete:${id}`
  }
};

const KNOWN_GATEWAYS = ['HELSINKI', 'NUREMBERG', 'XPS'];

module.exports = {
  CUSTOM_IDS,
  KNOWN_GATEWAYS,
};
