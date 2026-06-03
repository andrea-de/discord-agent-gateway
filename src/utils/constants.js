const CUSTOM_IDS = {
  GATEWAY: {
    INFO: 'gateway:info',
    SESSIONS: 'gateway:sessions',
    OPEN_PROJECT: (gateway, project) => `gateway:open-project:${gateway}:${project}`
  },
  PROJECT: {
    NEW_SESSION: 'project:new-session',
    HISTORY: 'project:history',
    README: 'project:readme',
    FILES: 'project:files',
    GIT: 'project:git',
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
