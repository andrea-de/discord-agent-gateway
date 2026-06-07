const { parsePrompts, stripDuplicatePrefix } = require('../parser');

class AgyDriver {
  getCommand() {
    return 'agy';
  }

  isInteractive() {
    return false;
  }

  getProviderUsageInfo(threadTokens, activeModel, modelTotalsMap) {
    const MODEL_LIMITS = {
      'Gemini 3.5 Flash (Medium)': 1000000,
      'Gemini 3.5 Flash (High)': 500000,
      'Gemini 3.5 Flash (Low)': 2000000,
      'Gemini 3.1 Pro (Low)': 250000,
      'Gemini 3.1 Pro (High)': 100000,
      'Claude Sonnet 4.6 (Thinking)': 200000,
    };

    const cleanModelName = (modelName) => {
      if (!modelName) return 'Gemini 3.5 Flash (Medium)';
      const lower = modelName.toLowerCase();
      if (lower.includes('flash') && lower.includes('medium')) return 'Gemini 3.5 Flash (Medium)';
      if (lower.includes('flash') && lower.includes('high')) return 'Gemini 3.5 Flash (High)';
      if (lower.includes('flash') && lower.includes('low')) return 'Gemini 3.5 Flash (Low)';
      if (lower.includes('pro') && lower.includes('low')) return 'Gemini 3.1 Pro (Low)';
      if (lower.includes('pro') && lower.includes('high')) return 'Gemini 3.1 Pro (High)';
      if (lower.includes('sonnet') || lower.includes('claude')) return 'Claude Sonnet 4.6 (Thinking)';
      if (lower.includes('flash')) return 'Gemini 3.5 Flash (Medium)';
      if (lower.includes('pro')) return 'Gemini 3.1 Pro (Low)';
      return modelName;
    };

    const getProgressBar = (percent) => {
      const totalChars = 55;
      const filledChars = Math.max(0, Math.min(totalChars, Math.round((percent / 100) * totalChars)));
      let barStr = '';
      for (let i = 0; i < totalChars; i++) {
        barStr += i < filledChars ? '█' : '░';
      }
      const blocks = [];
      for (let i = 0; i < 5; i++) {
        blocks.push(barStr.substring(i * 11, (i + 1) * 11));
      }
      return blocks.join(' ');
    };

    // Calculate dynamic reset time (every 6 hour boundary)
    const now = new Date();
    const nextReset = new Date();
    nextReset.setUTCMinutes(0, 0, 0);
    const hours = now.getUTCHours();
    const nextHour = 6 - (hours % 6);
    nextReset.setUTCHours(hours + nextHour);
    const diffMs = nextReset - now;
    const diffHours = Math.floor(diffMs / 3600000);
    const diffMins = Math.floor((diffMs % 3600000) / 60000);
    const resetStr = `Resets in ${diffHours}h ${diffMins}m`;

    const cleanedUsage = {};
    if (modelTotalsMap) {
      for (const [modelKey, tokens] of modelTotalsMap.entries()) {
        const cleanName = cleanModelName(modelKey);
        cleanedUsage[cleanName] = (cleanedUsage[cleanName] || 0) + tokens;
      }
    }

    const cleanedActiveModel = cleanModelName(activeModel);

    let details = `### ♊ Google Gemini API Usage & Quotas\n`;
    details += `* **Active Thread Model:** \`${cleanedActiveModel}\`\n\n`;
    details += `\`\`\`text\n`;
    details += `└ Model Quota\n\n`;

    const modelsToDisplay = [
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.5 Flash (High)',
      'Gemini 3.5 Flash (Low)',
      'Gemini 3.1 Pro (Low)',
      'Gemini 3.1 Pro (High)',
      'Claude Sonnet 4.6 (Thinking)',
    ];

    modelsToDisplay.forEach(modelName => {
      const used = cleanedUsage[modelName] || 0;
      const limit = MODEL_LIMITS[modelName];
      const remainingPercent = Math.max(0, Math.min(100, Math.round(((limit - used) / limit) * 100)));
      const barStr = getProgressBar(remainingPercent);
      const statusStr = remainingPercent > 0 ? 'Quota available' : 'Quota exhausted';
      const isActive = cleanedActiveModel === modelName;

      details += `  ${modelName}${isActive ? ' (active) ★' : ''}\n`;
      details += `  ${barStr} ${remainingPercent}%\n`;
      details += `  ${statusStr} (${used.toLocaleString()} / ${limit.toLocaleString()} tokens used)\n\n`;
    });

    details += `  ${resetStr}\n`;
    details += `\`\`\`\n`;

    return details;
  }

  getArgs({ prompt, mode, isContinue, model, flags, directory, sandbox }) {
    let args = [];
    
    if (mode === 'yolo') {
      args = ['--print', prompt, '--dangerously-skip-permissions'];
    } else {
      args = ['--print', prompt];
    }
    
    if (isContinue) {
      args.push('--continue');
    }

    if (directory) {
      args.push('--add-dir', directory);
    }

    if (sandbox === true) {
      args.push('--sandbox');
    }

    if (flags) {
      args.push(...this._parseFlags(flags));
    }

    return args;
  }

  getResumeArgs({ sessionId, prompt, mode, flags, directory, sandbox }) {
    let args = ['--conversation', sessionId];
    
    if (prompt) {
      args.push('--print', prompt);
    }
    
    if (mode === 'yolo') {
      args.push('--dangerously-skip-permissions');
    }

    if (directory) {
      args.push('--add-dir', directory);
    }

    if (sandbox === true) {
      args.push('--sandbox');
    }

    if (flags) {
      args.push(...this._parseFlags(flags));
    }

    return args;
  }

  findSessionId(directory) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    let resolvedDir = directory;
    if (directory.startsWith('~')) {
      resolvedDir = path.join(os.homedir(), directory.substring(1));
    }
    resolvedDir = path.resolve(resolvedDir);

    const logDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
    if (!fs.existsSync(logDir)) return null;

    try {
      const files = fs.readdirSync(logDir)
        .filter(f => f.startsWith('cli-') && f.endsWith('.log'))
        .map(f => {
          const filePath = path.join(logDir, f);
          const stat = fs.statSync(filePath);
          return { name: f, path: filePath, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);

      // Look through recent log files (up to 20)
      for (const file of files.slice(0, 20)) {
        try {
          const content = fs.readFileSync(file.path, 'utf8');
          if (content.includes(resolvedDir)) {
            const match = content.match(/(?:Created|found) conversation ([a-f0-9-]{36})/i) ||
                          content.match(/switching to conversation ([a-f0-9-]{36})/i) ||
                          content.match(/Conversation using project ID.*?\n.*?([a-f0-9-]{36})/i);
            if (match && match[1]) {
              return match[1];
            }
          }
        } catch (e) {}
      }
    } catch (e) {
      console.error('Error finding Antigravity session ID from CLI logs:', e);
    }
    return null;
  }

  getAvailableSessions(directory) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    let resolvedDir = directory;
    if (directory.startsWith('~')) {
      resolvedDir = path.join(os.homedir(), directory.substring(1));
    }
    resolvedDir = path.resolve(resolvedDir);

    const sessionsMap = new Map();
    const logDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');

    const getRelativeTime = (date) => {
      const seconds = Math.floor((new Date() - date) / 1000);
      let interval = Math.floor(seconds / 31536000);
      if (interval >= 1) return `${interval}y ago`;
      interval = Math.floor(seconds / 2592000);
      if (interval >= 1) return `${interval}mo ago`;
      interval = Math.floor(seconds / 86400);
      if (interval >= 1) return `${interval}d ago`;
      interval = Math.floor(seconds / 3600);
      if (interval >= 1) return `${interval}h ago`;
      interval = Math.floor(seconds / 60);
      if (interval >= 1) return `${interval}m ago`;
      return 'just now';
    };

    if (fs.existsSync(logDir)) {
      try {
        const files = fs.readdirSync(logDir)
          .filter(f => f.startsWith('cli-') && f.endsWith('.log'))
          .map(f => {
            const filePath = path.join(logDir, f);
            const stat = fs.statSync(filePath);
            return { name: f, path: filePath, mtime: stat.mtimeMs };
          })
          .sort((a, b) => b.mtime - a.mtime);

        for (const file of files.slice(0, 100)) {
          try {
            const content = fs.readFileSync(file.path, 'utf8');
            if (content.includes(resolvedDir)) {
              const match = content.match(/(?:Created|found) conversation ([a-f0-9-]{36})/i) ||
                            content.match(/switching to conversation ([a-f0-9-]{36})/i);
              if (match && match[1]) {
                const sessionId = match[1];
                if (!sessionsMap.has(sessionId)) {
                  let timestamp = new Date(file.mtime);
                  let firstPrompt = 'Antigravity Session';
                  let msgCount = 0;
                  
                  const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', sessionId);
                  const transcriptPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
                  const titleJsonPath = path.join(brainDir, '.system_generated', 'title.json');
                  
                  if (fs.existsSync(titleJsonPath)) {
                    try {
                      firstPrompt = JSON.parse(fs.readFileSync(titleJsonPath, 'utf8')).title;
                    } catch (e) {}
                  }
                  
                  if (fs.existsSync(transcriptPath)) {
                    try {
                      const stat = fs.statSync(transcriptPath);
                      timestamp = stat.mtime;
                      
                      const transcriptContent = fs.readFileSync(transcriptPath, 'utf8');
                      const lines = transcriptContent.split('\n').filter(l => l.trim().length > 0);
                      
                      for (const line of lines) {
                        try {
                          const step = JSON.parse(line);
                          if (step.type === 'USER_INPUT') {
                            msgCount++;
                            if (firstPrompt === 'Antigravity Session') {
                              let userContent = step.content || '';
                              const reqMatch = userContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
                              if (reqMatch) {
                                userContent = reqMatch[1].trim();
                              }
                              firstPrompt = userContent.split('\n')[0].substring(0, 60);
                            }
                          } else if (step.type === 'PLANNER_RESPONSE') {
                            msgCount++;
                          }
                        } catch (e) {}
                      }
                    } catch (e) {}
                  }
                  
                  const relTime = getRelativeTime(timestamp);
                  sessionsMap.set(sessionId, {
                    id: sessionId,
                    timestamp: timestamp,
                    label: `${firstPrompt.substring(0, 70)} (${relTime})`,
                    description: `[${msgCount} turns] [${sessionId.substring(0, 8)}]`
                  });
                }
              }
            }
          } catch (e) {}
        }
      } catch (e) {
        console.error('Error listing Antigravity sessions from CLI logs:', e);
      }
    }

    const sessions = Array.from(sessionsMap.values());
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
  }

  renameSession(sessionId, newName) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', sessionId);
    const titleJsonPath = path.join(brainDir, '.system_generated', 'title.json');
    
    try {
      if (!fs.existsSync(path.dirname(titleJsonPath))) {
        fs.mkdirSync(path.dirname(titleJsonPath), { recursive: true });
      }
      fs.writeFileSync(titleJsonPath, JSON.stringify({ title: newName }, null, 2));
      return true;
    } catch (e) {
      console.error('Error renaming Antigravity session:', e);
      return false;
    }
  }

  getAvailableModels() {
    const { execSync } = require('child_process');
    try {
      const output = execSync('agy models', { encoding: 'utf8' });
      const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      const lines = output.split('\n')
        .map(l => l.trim())
        .filter(l => {
          if (!l) return false;
          if (l.includes('Fetching available models')) return false;
          if (spinnerChars.some(char => l.startsWith(char))) return false;
          return true;
        });
      
      return lines.map(modelName => ({
        name: modelName,
        value: modelName
      }));
    } catch (e) {
      console.error('Error fetching agy models:', e);
      return [
        { name: 'Gemini 3.5 Flash (Medium)', value: 'Gemini 3.5 Flash (Medium)' },
        { name: 'Gemini 3.5 Flash (High)', value: 'Gemini 3.5 Flash (High)' },
        { name: 'Gemini 3.5 Flash (Low)', value: 'Gemini 3.5 Flash (Low)' },
        { name: 'Gemini 3.1 Pro (Low)', value: 'Gemini 3.1 Pro (Low)' },
        { name: 'Gemini 3.1 Pro (High)', value: 'Gemini 3.1 Pro (High)' },
        { name: 'Claude Sonnet 4.6 (Thinking)', value: 'Claude Sonnet 4.6 (Thinking)' }
      ];
    }
  }

  exportSession(sessionId, directory, options = { verbose: false }) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', sessionId);
    const transcriptPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) return null;

    try {
      const fileContent = fs.readFileSync(transcriptPath, 'utf8');
      const lines = fileContent.split('\n').filter(l => l.trim().length > 0);
      let content = `# Discord Chat-Ops Session Export\n* **Tool:** ANTIGRAVITY\n* **Directory:** \`${directory || 'Unknown'}\`\n* **Session ID:** \`${sessionId}\`\n* **Export Time:** ${new Date().toISOString()}\n\n---\n\n## Conversation Log\n\n`;

      const isVerbose = options && options.verbose;

      for (const line of lines) {
        try {
          const step = JSON.parse(line);
          const timeStr = step.created_at ? new Date(step.created_at).toISOString() : '';
          
          if (step.type === 'USER_INPUT') {
            let userContent = step.content || '';
            const reqMatch = userContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (reqMatch) {
              userContent = reqMatch[1].trim();
            }
            content += `### [${timeStr}] 👤 **User**\n${userContent}\n\n`;
          } else if (step.type === 'PLANNER_RESPONSE') {
            const plannerContent = step.content || '';
            content += `### [${timeStr}] 🤖 **Bot (Antigravity)**\n${plannerContent}\n\n`;
          } else if (isVerbose) {
            if (step.type === 'CONVERSATION_HISTORY') {
              continue;
            }
            const toolType = step.type.replace(/_/g, ' ').toUpperCase();
            content += `### [${timeStr}] 🛠️ **System Action (${toolType})**\n\`\`\`\n${step.content || ''}\n\`\`\`\n\n`;
          }
        } catch (e) {}
      }

      const exportFile = path.join('/tmp', `gateway-export-agy-${sessionId}.md`);
      fs.writeFileSync(exportFile, content);
      return exportFile;
    } catch (err) {
      console.error('Failed to export Antigravity session:', err);
      return null;
    }
  }

  getEnv({ model }) {
    const env = {};
    if (model) {
      env.GEMINI_MODEL = model;
      env.MODEL = model;
    }
    return env;
  }

  parseTokenUsage(logs) {
    const tokenMatch = logs.match(/tokens used\s*\n\s*([\d,]+)/i) || 
                       logs.match(/(\d+)\s*(?:total\s*)?tokens/i) || 
                       logs.match(/tokens?:\s*(\d+)/i);
    if (tokenMatch) {
      return parseInt(tokenMatch[1].replace(/,/g, ''), 10);
    }
    return null;
  }

  parseInteractivePrompts(buffer) {
    // Standard agy prompts
    return parsePrompts(buffer);
  }

  stripDuplicateHistory(oldText, newText) {
    return stripDuplicatePrefix(oldText, newText);
  }

  /**
   * Helper to parse arbitrary space-separated CLI flags, respecting quotes.
   */
  _parseFlags(flagsStr) {
    if (!flagsStr) return [];
    const matches = flagsStr.match(/[^\s"']+|"[^"]*"|'[^']*'/g);
    if (!matches) return [];
    return matches.map(arg => {
      if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
        return arg.substring(1, arg.length - 1);
      }
      return arg;
    });
  }

  deleteSession(sessionId) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    try {
      // 1. Delete brain folder
      const brainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', sessionId);
      if (fs.existsSync(brainDir)) {
        fs.rmSync(brainDir, { recursive: true, force: true });
      }

      // 2. Delete conversations DB files
      const convDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');
      if (fs.existsSync(convDir)) {
        const files = fs.readdirSync(convDir);
        for (const file of files) {
          if (file.startsWith(sessionId)) {
            try {
              fs.unlinkSync(path.join(convDir, file));
            } catch (err) {}
          }
        }
      }

      // 3. Delete log files referencing this session
      const logDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
      if (fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir);
        for (const file of files) {
          if (file.startsWith('cli-') && file.endsWith('.log')) {
            const filePath = path.join(logDir, file);
            try {
              const content = fs.readFileSync(filePath, 'utf8');
              if (content.includes(sessionId)) {
                fs.unlinkSync(filePath);
              }
            } catch (e) {}
          }
        }
      }

      return true;
    } catch (e) {
      console.error('Failed to delete Antigravity session:', e);
      throw e;
    }
  }
}

module.exports = new AgyDriver();
