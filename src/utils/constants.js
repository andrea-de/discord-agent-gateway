const CUSTOM_IDS = {
  GATEWAY: {
    INFO: 'gateway:info',
    SESSIONS: 'gateway:sessions',
    OPEN_PROJECT: (gateway, project) => `gateway:open-project:${gateway}:${project}`
  },
  PROJECT: {
    START_TOOL: (gateway, tool) => `project:${gateway}:start:${tool}`,
    HISTORY: (gateway) => `project:${gateway}:history`,
    README: (gateway) => `project:${gateway}:readme`,
    FILES: (gateway) => `project:${gateway}:files`,
    GIT: (gateway) => `project:${gateway}:git`,
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
