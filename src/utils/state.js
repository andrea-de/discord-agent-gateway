const fs = require('fs');
const path = require('path');
const os = require('os');

let client = null;
const threadMetadata = new Map();
const METADATA_DIR = path.join(os.homedir(), '.discord-agent-gateway');
const METADATA_FILE = path.join(METADATA_DIR, 'metadata.json');

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
      threadMetadata.clear();
      for (const [key, val] of Object.entries(data)) {
        threadMetadata.set(key, val);
      }
      console.log(`Loaded ${threadMetadata.size} thread metadata sessions from disk.`);
    }
  } catch (e) {
    console.error('Failed to load thread metadata:', e);
  }
}

function saveMetadata() {
  try {
    if (!fs.existsSync(METADATA_DIR)) {
      fs.mkdirSync(METADATA_DIR, { recursive: true });
    }
    const obj = Object.fromEntries(threadMetadata);
    fs.writeFileSync(METADATA_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Failed to save thread metadata:', e);
  }
}

function getOrInferMetadata(channel) {
  if (!channel) return null;
  const threadId = channel.id;
  let meta = threadMetadata.get(threadId);
  if (meta) return meta;

  if (channel.isThread()) {
    try {
      const { resolveGatewayAndProject, resolveProjectDirectory } = require('../services/projectService');
      const parent = channel.parent;
      if (parent) {
        const { project } = resolveGatewayAndProject(parent);
        if (project) {
          const dir = resolveProjectDirectory(project);
          if (dir) {
            const threadName = channel.name.toLowerCase();
            let inferredTool = null;
            if (threadName.includes('gemini')) inferredTool = 'gemini';
            else if (threadName.includes('antigravity') || threadName.includes('[agy]') || threadName.includes('[antigravity]')) inferredTool = 'agy';
            else if (threadName.includes('codex')) inferredTool = 'codex';
            else if (threadName.includes('bash')) inferredTool = 'bash';

            if (inferredTool) {
              meta = {
                tool: inferredTool,
                directory: dir,
                mode: 'review',
                hasStarted: false,
                hideExecDetails: true
              };
              threadMetadata.set(threadId, meta);
              saveMetadata();
              console.log(`[Self-Healing] Successfully recovered metadata for thread ${threadId}: tool=${inferredTool}, dir=${dir}`);
              return meta;
            }
          }
        }
      }
    } catch (err) {
      console.error('[Self-Healing] Failed to infer metadata:', err);
    }
  }
  return null;
}

module.exports = {
  getClient,
  setClient,
  threadMetadata,
  loadMetadata,
  saveMetadata,
  uiState,
  currentGateway,
  getOrInferMetadata,
};
