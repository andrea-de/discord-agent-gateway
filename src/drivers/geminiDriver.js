const { parsePrompts, stripDuplicatePrefix } = require('../parser');

class GeminiDriver {
  getCommand() {
    return 'gemini';
  }

  isInteractive() {
    return false;
  }

  getProviderUsageInfo(threadTokens, activeModel, modelTotalsMap) {
    // Similar to agy, but maybe with different limits or names if appropriate
    // For now, I'll use a simplified version or reuse the agy logic if it fits.
    
    let details = `### ♊ Gemini CLI Usage & Quotas\n`;
    details += `* **Active Thread Model:** \`${activeModel || 'Default'}\`\n\n`;
    
    details += `**Token Usage Breakdown:**\n`;
    if (!modelTotalsMap || modelTotalsMap.size === 0) {
      details += `* \`${activeModel || 'Default'}\`: \`${threadTokens.toLocaleString()} tokens\`\n`;
    } else {
      for (const [model, tokens] of modelTotalsMap.entries()) {
        details += `* \`${model}\`: \`${tokens.toLocaleString()} tokens\`\n`;
      }
    }
    
    return details;
  }

  getArgs({ prompt, mode, isContinue, model, flags, directory, sandbox }) {
    let args = [];
    
    // The gemini CLI uses --prompt for non-interactive execution
    args = ['--prompt', prompt];

    // Handle approval mode and YOLO based on global mode or thread-specific policy
    if (mode === 'yolo' || sandbox === 'yolo') {
      args.push('--yolo');
    } else if (sandbox && ['auto_edit', 'plan', 'default'].includes(sandbox)) {
      args.push('--approval-mode', sandbox);
    }
    
    if (isContinue) {
      args.push('--resume', 'latest');
    }

    if (model) {
      args.push('--model', model);
    }

    if (sandbox === true || sandbox === 'true') {
      args.push('--sandbox');
    }

    if (flags) {
      args.push(...this._parseFlags(flags));
    }

    return args;
  }

  getEnv({ model }) {
    const env = {};
    if (model) {
      env.GEMINI_MODEL = model;
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
    return parsePrompts(buffer);
  }

  getResumeArgs({ sessionId, prompt, mode, flags, directory, sandbox }) {
    let args = [];
    
    if (prompt) {
      args = ['--prompt', prompt];
    }
    
    args.push('--resume', sessionId);

    if (mode === 'yolo' || sandbox === 'yolo') {
      args.push('--yolo');
    } else if (sandbox && ['auto_edit', 'plan', 'default'].includes(sandbox)) {
      args.push('--approval-mode', sandbox);
    }

    if (sandbox === true || sandbox === 'true') {
      args.push('--sandbox');
    }

    if (flags) {
      args.push(...this._parseFlags(flags));
    }

    return args;
  }

  _getProjectName(directory) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const projectsFile = path.join(os.homedir(), '.gemini', 'projects.json');
    if (!fs.existsSync(projectsFile)) return null;
    try {
      const { projects } = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      let targetDir = path.resolve(directory.replace(/^~/, os.homedir()));
      for (const [dirPath, name] of Object.entries(projects)) {
        const resolvedPath = path.resolve(dirPath.replace(/^~/, os.homedir()));
        if (resolvedPath === targetDir) {
          return name;
        }
      }
    } catch (e) {
      console.error('Error reading projects.json:', e);
    }
    return null;
  }

  findSessionId(directory) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    const projectName = this._getProjectName(directory);
    if (!projectName) return null;
    
    const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectName, 'chats');
    if (!fs.existsSync(chatsDir)) return null;
    
    try {
      const files = fs.readdirSync(chatsDir);
      let latestSessionId = null;
      let latestMtime = 0;
      
      for (const file of files) {
        if (file.startsWith('session-') && file.endsWith('.jsonl')) {
          const filePath = path.join(chatsDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs > latestMtime) {
              const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
              const meta = JSON.parse(firstLine);
              if (meta.sessionId) {
                latestMtime = stat.mtimeMs;
                latestSessionId = meta.sessionId;
              }
            }
          } catch (e) {}
        }
      }
      return latestSessionId;
    } catch (e) {
      console.error('Error finding Gemini session ID:', e);
      return null;
    }
  }

  getAvailableSessions(directory) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    const projectName = this._getProjectName(directory);
    if (!projectName) return [];
    
    const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectName, 'chats');
    if (!fs.existsSync(chatsDir)) return [];
    
    try {
      const files = fs.readdirSync(chatsDir);
      const fileStats = [];
      
      for (const file of files) {
        if (file.startsWith('session-') && file.endsWith('.jsonl')) {
          const filePath = path.join(chatsDir, file);
          try {
            const stat = fs.statSync(filePath);
            fileStats.push({ file, mtime: stat.mtimeMs });
          } catch (e) {}
        }
      }

      fileStats.sort((a, b) => b.mtime - a.mtime);
      
      const sessions = [];
      const seen = new Set();
      
      for (const item of fileStats) {
        const filePath = path.join(chatsDir, item.file);
        try {
          const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
          if (lines.length === 0) continue;
          
          const meta = JSON.parse(lines[0]);
          const sessionId = meta.sessionId;
          if (!sessionId) continue;
          
          if (seen.has(sessionId)) continue;
          seen.add(sessionId);
          
          let firstMsg = '';
          let msgCount = 0;
          for (let i = 1; i < lines.length; i++) {
            try {
              const turn = JSON.parse(lines[i]);
              if (turn.type === 'user' || turn.type === 'gemini') {
                msgCount++;
              } else if (turn.$set && turn.$set.messages) {
                msgCount += turn.$set.messages.length;
              }
              
              if (turn.type === 'user' && turn.content && turn.content[0] && turn.content[0].text) {
                const text = turn.content[0].text;
                if (!text.includes('<session_context>') && !firstMsg) {
                  firstMsg = text;
                }
              } else if (turn.$set && turn.$set.messages) {
                const messages = turn.$set.messages;
                const userMsg = messages.find(m => m.type === 'user');
                if (userMsg && userMsg.content && userMsg.content[0] && userMsg.content[0].text) {
                  const text = userMsg.content[0].text;
                  if (!text.includes('<session_context>') && !firstMsg) {
                    firstMsg = text;
                  }
                }
              }
            } catch (e) {}
          }
          
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
          
          const relTime = getRelativeTime(new Date(item.mtime));
          const title = firstMsg ? firstMsg : 'Gemini Session';
          sessions.push({
            id: sessionId,
            label: `${title.substring(0, 70)} (${relTime})`,
            description: `[${msgCount} messages] [${sessionId.substring(0, 8)}]`
          });
        } catch (e) {}
      }
      
      return sessions.slice(0, 25);
    } catch (e) {
      console.error('Error reading Gemini sessions:', e);
      return [];
    }
  }

  exportSession(sessionId, directory, options = { verbose: false }) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const projectName = this._getProjectName(directory);
    if (!projectName) return null;
    
    const chatsDir = path.join(os.homedir(), '.gemini', 'tmp', projectName, 'chats');
    if (!fs.existsSync(chatsDir)) return null;
    
    const isVerbose = options && options.verbose;
    
    try {
      const files = fs.readdirSync(chatsDir);
      let targetFile = null;
      
      for (const file of files) {
        if (file.startsWith('session-') && file.endsWith('.jsonl')) {
          const filePath = path.join(chatsDir, file);
          try {
            const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
            const meta = JSON.parse(firstLine);
            if (meta.sessionId === sessionId) {
              targetFile = filePath;
              break;
            }
          } catch (e) {}
        }
      }
      
      if (!targetFile) return null;
      
      const lines = fs.readFileSync(targetFile, 'utf8').split('\n').filter(Boolean);
      let content = `# Gemini Session Native Logs Export\n* **Session ID:** \`${sessionId}\`\n* **Project:** \`${projectName}\`\n\n`;
      
      const turnMap = new Map();
      const turnOrder = [];
      
      for (let i = 1; i < lines.length; i++) {
        try {
          const turn = JSON.parse(lines[i]);
          if (turn.id) {
            if (!turnMap.has(turn.id)) {
              turnOrder.push(turn.id);
            }
            turnMap.set(turn.id, turn);
          } else if (turn.$set && turn.$set.messages) {
            for (const msg of turn.$set.messages) {
              if (msg.id) {
                if (!turnMap.has(msg.id)) {
                  turnOrder.push(msg.id);
                }
                turnMap.set(msg.id, msg);
              }
            }
          }
        } catch (e) {}
      }
      
      for (const id of turnOrder) {
        const turn = turnMap.get(id);
        if (turn.type === 'user') {
          const hasText = turn.content && turn.content.some(c => typeof c.text === 'string' && c.text.trim() !== '');
          if (!hasText) continue;
          
          let text = '';
          for (const part of turn.content) {
            if (part.text) {
              text += part.text;
            }
          }
          if (text.includes('<session_context>')) continue;
          content += `### [${turn.timestamp || ''}] **USER**\n${text}\n\n`;
        } else if (turn.type === 'gemini') {
          let geminiText = '';
          if (typeof turn.content === 'string') {
            geminiText = turn.content;
          } else if (Array.isArray(turn.content)) {
            geminiText = turn.content.map(c => c.text || '').join('');
          }
          
          let toolText = '';
          if (isVerbose && turn.toolCalls && turn.toolCalls.length > 0) {
            toolText += `**Tool Calls:**\n`;
            for (const call of turn.toolCalls) {
              toolText += `* **Call tool:** \`${call.name}\` with args:\n\`\`\`json\n${JSON.stringify(call.args, null, 2)}\n\`\`\`\n`;
              if (call.result && call.result.length > 0) {
                for (const res of call.result) {
                  if (res.functionResponse && res.functionResponse.response) {
                    const output = res.functionResponse.response.output;
                    let formattedOutput = '';
                    if (typeof output === 'string') {
                      formattedOutput = output;
                    } else {
                      formattedOutput = JSON.stringify(output, null, 2);
                    }
                    toolText += `  **Result:**\n\`\`\`\n${formattedOutput}\n\`\`\`\n`;
                  }
                }
              }
            }
          }
          
          content += `### [${turn.timestamp || ''}] **GEMINI**\n`;
          if (geminiText) {
            content += `${geminiText}\n\n`;
          }
          if (toolText) {
            content += `${toolText}\n`;
          }
          if (!geminiText && !toolText) {
            content += `*(No text or tool calls response)*\n\n`;
          }
        }
      }
      
      const exportFile = path.join('/tmp', `gemini-native-export-${sessionId}.md`);
      fs.writeFileSync(exportFile, content);
      return exportFile;
    } catch (e) {
      console.error('Failed to export Gemini native session:', e);
      return null;
    }
  }

  stripDuplicateHistory(oldText, newText) {
    return stripDuplicatePrefix(oldText, newText);
  }

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
}

module.exports = new GeminiDriver();
