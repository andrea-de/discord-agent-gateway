const fs = require('fs');
const path = require('path');

let client = null;
let threadMetadata = new Map();
const METADATA_FILE = path.join(__dirname, '../../.thread-metadata.json');

const uiState = {
  onlineMessage: null,
  infoMessage: null,
  sessionsMessage: null,
};

const currentGateway = (process.env.GATEWAY_NAME || 'HELSINKI').toUpperCase();

function setClient(c) {
  client = c;
}

function getClient() {
  return client;
}

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      threadMetadata = new Map(Object.entries(data));
      console.log(`Loaded ${threadMetadata.size} thread metadata sessions from disk.`);
    }
  } catch (e) {
    console.error('Failed to load thread metadata:', e);
  }
}

function saveMetadata() {
  try {
    const obj = Object.fromEntries(threadMetadata);
    fs.writeFileSync(METADATA_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Failed to save thread metadata:', e);
  }
}

const USAGE_FILE = path.join(__dirname, '../../.usage-registry.json');
function recordUsage(tool, threadId, model, tokens) {
  if (!tokens || isNaN(tokens)) return;
  try {
    let data = [];
    if (fs.existsSync(USAGE_FILE)) {
      data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    }
    data.push({
      timestamp: new Date().toISOString(),
      threadId,
      tool,
      model: model || 'Default',
      tokens
    });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to record usage:', e);
  }
}

module.exports = {
  getClient,
  setClient,
  threadMetadata,
  loadMetadata,
  saveMetadata,
  uiState,
  currentGateway,
  recordUsage
};
