const { parsePrompts, stripDuplicatePrefix } = require('../parser');

class CodexDriver {
  constructor() {
    this.discordResponseInstruction = [
      '',
      '---',
      'Gateway response style:',
      '- Keep Discord-facing progress and final responses concise.',
      '- Use short bullets when listing changes, tests, blockers, or next steps.',
      '- Avoid restating command output or logs unless it is needed to explain a result.',
      '- Keep the final reply under 8 lines unless the user explicitly asks for detail.'
    ].join('\n');
  }

  getCommand() {
    return 'codex';
  }

  isInteractive() {
    return false;
  }

  getProviderUsageInfo(threadTokens, activeModel, modelTotalsMap) {
    let details = `### 🧠 OpenAI Codex API Usage\n`;
    details += `* **Active Thread Model:** \`${activeModel || 'Default Codex Model'}\`\n\n`;
    
    details += `**Token Usage Breakdown by Model:**\n`;
    if (!modelTotalsMap || modelTotalsMap.size === 0) {
      const fallbackModel = activeModel || 'Default Codex Model';
      details += `* \`${fallbackModel}\`: \`${threadTokens.toLocaleString()} tokens\`\n`;
    } else {
      for (const [model, tokens] of modelTotalsMap.entries()) {
        details += `* \`${model}\`: \`${tokens.toLocaleString()} tokens\`\n`;
      }
    }
    
    details += `\n* **Reset Interval:** Organization billing quotas typically reset monthly. Rate limits (RPM/TPM) reset every minute.`;
    return details;
  }

  getArgs({ prompt, mode, isContinue, model, flags, directory, sandbox }) {
    const bypassSandbox = mode === 'yolo' || sandbox === 'danger-full-access';
    const effectivePrompt = this._withDiscordResponseInstruction(prompt);
    const skipGitRepoCheck = this._shouldSkipGitRepoCheck(directory);
    let args = [];

    if (isContinue) {
      // Resume session non-interactively
      args = ['exec', 'resume', '--last'];
      if (bypassSandbox) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
      if (model) {
        args.push('-m', model);
      }
      if (flags) {
        args.push(...this._parseFlags(flags));
      }
      if (skipGitRepoCheck) {
        args.push('--skip-git-repo-check');
      }
      args.push(effectivePrompt);
    } else {
      // Start fresh session non-interactively
      args = ['exec'];
      if (bypassSandbox) {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      } else {
        args.push('-s', sandbox || 'workspace-write');
      }
      if (model) {
        args.push('-m', model);
      }
      if (directory) {
        args.push('-C', directory);
      }
      if (flags) {
        args.push(...this._parseFlags(flags));
      }
      if (skipGitRepoCheck) {
        args.push('--skip-git-repo-check');
      }
      args.push(effectivePrompt);
    }

    return args;
  }

  getEnv() {
    // Codex uses native config or -m flag
    return {};
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
    // Standard codex interactive prompts
    return parsePrompts(buffer);
  }

  stripDuplicateHistory(oldText, newText, hideExecDetails = false) {
    // 1. Extract only the actual response block (after the header and 'codex' prompt)
    const match = newText.match(/(?:^|[\s\S]*?\n)(?:user\b[\s\S]*?\bcodex\s*\n)([\s\S]*)/i);
    if (!match) {
      // Suppress all header outputs before the prompt boundary
      return '';
    }

    let cleaned = match[1];

    // 2. Discard the 'tokens used' line and everything after it to prevent duplicate reprint
    const tokensIndex = cleaned.toLowerCase().indexOf('tokens used');
    if (tokensIndex !== -1) {
      cleaned = cleaned.substring(0, tokensIndex).trim();
    }

    // Format exec blocks, apply patch blocks, and diff patches to be clean and concise
    const blockRegex = /(?:exec\r?\n([^\r\n]+)\r?\n\s*(succeeded in \d+ms:|failed with exit code \d+:)([\s\S]*?)(?=\r?\n(?:exec|codex|apply patch|tokens used)|$))|(?:apply patch\r?\npatch: [^\r\n]+\r?\n[^\r\n]+\r?\n)?(diff --git\s+[^\r\n]+[\s\S]*?)(?=\r?\n(?:exec|codex|apply patch|tokens used)|$)/gi;
    
    if (hideExecDetails) {
      cleaned = cleaned.replace(blockRegex, '').replace(/\r?\n\s*\r?\n/g, '\n\n').trim();
    } else {
      cleaned = cleaned.replace(blockRegex, (match, execCmdLine, execStatus, execOutput, standaloneDiff) => {
      if (execCmdLine) {
        const cmdLine = execCmdLine.trim();
        const status = execStatus.trim();
        const output = execOutput.trim();

        let commandOnly = cmdLine;
        const bashMatchSingle = cmdLine.match(/\/bin\/bash\s+-lc\s+'([^']+)'/);
        const bashMatchDouble = cmdLine.match(/\/bin\/bash\s+-lc\s+"([^"]+)"/);
        const bashMatchSimple = cmdLine.match(/\/bin\/bash\s+-lc\s+([^\s]+)/);

        if (bashMatchSingle) {
          commandOnly = bashMatchSingle[1];
        } else if (bashMatchDouble) {
          commandOnly = bashMatchDouble[1];
        } else if (bashMatchSimple) {
          commandOnly = bashMatchSimple[1];
        }

        let dirSuffix = '';
        const dirMatch = cmdLine.match(/\s+in\s+(.+)$/);
        if (dirMatch) {
          const parts = dirMatch[1].split(/[/\\]/).filter(Boolean);
          const dirName = parts.pop() || '';
          dirSuffix = ` in \`${dirName}\``;
        }

        const statusSymbol = status.includes('succeeded') ? '✅' : '❌';
        let outputSnippet = '';
        if (status.includes('failed') && output.length > 0) {
          const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length > 0) {
            outputSnippet = `\n> Error: \`${lines[0]}\``;
          }
        }

        // Suppress successful diff outputs from exec commands, only show summary
        return `* **Command:** \`${commandOnly}\`${dirSuffix} ${statusSymbol}${outputSnippet}`;
      } else if (standaloneDiff) {
        // Parse modified files and line differences from the diff block to show a clean summary
        const fileDiffs = standaloneDiff.split(/^diff --git /m);
        const summaries = [];
        for (const fileDiff of fileDiffs) {
          if (!fileDiff.trim()) continue;
          const fileMatch = fileDiff.match(/^a\/(.+?) b\//);
          if (!fileMatch) continue;
          const filepath = fileMatch[1];
          let additions = 0;
          let deletions = 0;
          const lines = fileDiff.split('\n');
          for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++ ')) {
              additions++;
            } else if (line.startsWith('-') && !line.startsWith('--- ')) {
              deletions++;
            }
          }
          summaries.push({ filepath, additions, deletions });
        }
        if (summaries.length > 0) {
          // Deduplicate by file path, keeping the last one
          const grouped = new Map();
          for (const s of summaries) {
            grouped.set(s.filepath, s);
          }
          const summaryStr = [...grouped.values()].map(s => `\`${s.filepath}\` (+${s.additions}, -${s.deletions} lines)`).join(', ');
          return `📝 **Updated:** ${summaryStr}`;
        }
        return '';
      }

      return match;
    });
    }

    // Clean up raw CLI internal prompts and replace turn markers with visual separators.
    // This must run after block formatting so exec parsing can stop at real turn markers.
    cleaned = cleaned.replace(/^\s*user\s*$/gm, '');
    cleaned = cleaned.replace(/^\s*codex\s*$/gm, '\n---\n');
    cleaned = cleaned.replace(/^\s*apply patch\s*$/gm, '');
    cleaned = cleaned.replace(/^\s*patch: completed\s*$/gm, '');

    // 3. Strip duplicate history (for continuation sessions)
    const { stripDuplicatePrefix } = require('../parser');
    return stripDuplicatePrefix(oldText, cleaned);
  }

  /**
   * Helper to parse arbitrary space-separated CLI flags, respecting quotes.
   */
  getResumeArgs({ sessionId, prompt, mode, flags, directory, sandbox }) {
    const bypassSandbox = mode === 'yolo' || sandbox === 'danger-full-access';
    const effectivePrompt = prompt ? this._withDiscordResponseInstruction(prompt) : null;
    const skipGitRepoCheck = this._shouldSkipGitRepoCheck(directory);
    let args = ['exec', 'resume'];

    if (bypassSandbox) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    if (skipGitRepoCheck) {
      args.push('--skip-git-repo-check');
    }
    if (flags) {
      args.push(...this._parseFlags(flags));
    }

    args.push(sessionId);
    if (effectivePrompt) {
      args.push(effectivePrompt);
    }
    return args;
  }

  findSessionId(directory) {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    let resolvedDir = directory;
    if (directory.startsWith('~')) {
      resolvedDir = path.join(os.homedir(), directory.substring(1));
    }
    resolvedDir = path.resolve(resolvedDir);

    const dbPath = path.join(os.homedir(), '.codex', 'state_5.sqlite');
    if (!fs.existsSync(dbPath)) return null;

    try {
      const query = `SELECT id FROM threads WHERE cwd = '${resolvedDir}' ORDER BY created_at DESC LIMIT 1`;
      const cmd = `sqlite3 -json ${dbPath} "${query}"`;
      const output = execSync(cmd, { encoding: 'utf8' }).trim();
      if (!output) return null;
      const records = JSON.parse(output);
      return records[0] ? records[0].id : null;
    } catch (e) {
      console.error('Error finding Codex session ID:', e);
      return null;
    }
  }

  getAvailableSessions(directory) {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    let resolvedDir = directory;
    if (directory.startsWith('~')) {
      resolvedDir = path.join(os.homedir(), directory.substring(1));
    }
    resolvedDir = path.resolve(resolvedDir);

    const dbPath = path.join(os.homedir(), '.codex', 'state_5.sqlite');
    if (!fs.existsSync(dbPath)) return [];
    
    try {
      const query = `SELECT id, title, created_at, tokens_used FROM threads WHERE cwd = '${resolvedDir}' ORDER BY created_at DESC LIMIT 25`;
      const cmd = `sqlite3 -json ${dbPath} "${query}"`;
      const output = execSync(cmd, { encoding: 'utf8' }).trim();
      if (!output) return [];
      
      const records = JSON.parse(output);
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

      return records.map(r => {
        const relTime = getRelativeTime(new Date(r.created_at * 1000));
        const title = r.title ? r.title : 'Codex Session';
        return {
          id: r.id,
          label: `${title.substring(0, 70)} (${relTime})`,
          description: `[${(r.tokens_used || 0).toLocaleString()} tokens] [${r.id.substring(0, 8)}]`
        };
      });
    } catch (e) {
      console.error('Error fetching Codex available sessions:', e);
      return [];
    }
  }

  exportSession(sessionId, directory, options = { verbose: false }) {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const isVerbose = options && options.verbose;
    
    try {
      const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
      const findRolloutFile = (dir, targetId) => {
        if (!fs.existsSync(dir)) return null;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findRolloutFile(fullPath, targetId);
            if (found) return found;
          } else if (entry.isFile() && entry.name.endsWith(`-${targetId}.jsonl`)) {
            return fullPath;
          }
        }
        return null;
      };

      const rolloutPath = findRolloutFile(sessionsDir, sessionId);
      if (rolloutPath) {
        const fileContent = fs.readFileSync(rolloutPath, 'utf8');
        const lines = fileContent.split('\n').filter(l => l.trim().length > 0);
        let content = `# Discord Chat-Ops Session Export\n* **Tool:** CODEX\n* **Directory:** \`${directory || 'Unknown'}\`\n* **Session ID:** \`${sessionId}\`\n* **Export Time:** ${new Date().toISOString()}\n\n---\n\n## Conversation Log\n\n`;
        
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            const timeStr = data.timestamp ? new Date(data.timestamp).toISOString() : '';
            
            if (data.type === 'response_item') {
              const payload = data.payload;
              if (payload && payload.type === 'message') {
                const role = payload.role;
                if (!isVerbose && (role === 'developer' || role === 'system')) {
                  continue;
                }
                const text = payload.content && payload.content[0] && payload.content[0].text;
                if (text) {
                  let cleanedText = text;
                  const instrIdx = cleanedText.indexOf('---');
                  if (instrIdx !== -1 && cleanedText.includes('Gateway response style:')) {
                    cleanedText = cleanedText.substring(0, instrIdx).trim();
                  }
                  
                  let author = '🤖 **Bot (Codex)**';
                  if (role === 'user') author = '👤 **User**';
                  else if (role === 'developer') author = '⚙️ **System Instructions**';
                  else if (role === 'system') author = '⚙️ **System**';
                  
                  content += `### [${timeStr}] ${author}\n${cleanedText}\n\n`;
                }
              } else if (isVerbose && payload && payload.type === 'function_call') {
                let argsStr = payload.arguments || '';
                try {
                  argsStr = JSON.stringify(JSON.parse(payload.arguments), null, 2);
                } catch (e) {}
                content += `### [${timeStr}] 🛠️ **Tool Call: \`${payload.name}\`**\n\`\`\`json\n${argsStr}\n\`\`\`\n\n`;
              } else if (isVerbose && payload && payload.type === 'function_call_output') {
                content += `### [${timeStr}] 📤 **Tool Output**\n\`\`\`\n${payload.output || ''}\n\`\`\`\n\n`;
              }
            } else if (isVerbose && data.type === 'event_msg') {
              const payload = data.payload;
              if (payload && payload.type === 'agent_message') {
                content += `### [${timeStr}] 💭 **Bot Commentary**\n${payload.message}\n\n`;
              }
            }
          } catch (e) {}
        }
        
        const exportFile = path.join('/tmp', `gateway-export-codex-${sessionId}.md`);
        fs.writeFileSync(exportFile, content);
        return exportFile;
      }
    } catch (err) {
      console.error('Failed to export from rollout file, trying sqlite:', err);
    }

    const dbPath = path.join(os.homedir(), '.codex', 'logs_2.sqlite');
    if (!fs.existsSync(dbPath)) return null;
    
    try {
      const { execSync } = require('child_process');
      const cmd = `sqlite3 -json ${dbPath} "SELECT ts, level, target, feedback_log_body FROM logs WHERE thread_id = '${sessionId}' ORDER BY id"`;
      const output = execSync(cmd, { encoding: 'utf8' }).trim();
      if (!output) return null;
      
      const records = JSON.parse(output);
      let content = `# Codex Session Native Logs Export\n* **Session ID:** \`${sessionId}\`\n\n`;
      for (const r of records) {
        const date = new Date(r.ts).toISOString();
        const body = r.feedback_log_body || '';
        content += `\`[${date}] [${r.level}] [${r.target}]\`\n${body}\n\n`;
      }
      
      const exportFile = path.join('/tmp', `codex-native-export-${sessionId}.md`);
      fs.writeFileSync(exportFile, content);
      return exportFile;
    } catch (err) {
      console.error('Failed to export Codex native session logs:', err);
      return null;
    }
  }

  getSessionTitle(sessionId) {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const dbPath = path.join(os.homedir(), '.codex', 'state_5.sqlite');
    if (!fs.existsSync(dbPath)) return null;
    try {
      const query = `SELECT title FROM threads WHERE id = '${sessionId}' LIMIT 1`;
      const cmd = `sqlite3 -json ${dbPath} "${query}"`;
      const output = execSync(cmd, { encoding: 'utf8' }).trim();
      if (!output) return null;
      const records = JSON.parse(output);
      return records[0] ? records[0].title : null;
    } catch (e) {
      return null;
    }
  }

  renameSession(sessionId, newName) {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    
    const dbPath = path.join(os.homedir(), '.codex', 'state_5.sqlite');
    if (!fs.existsSync(dbPath)) return false;
    
    try {
      const query = `UPDATE threads SET title = '${newName.replace(/'/g, "''")}' WHERE id = '${sessionId}'`;
      const cmd = `sqlite3 ${dbPath} "${query}"`;
      execSync(cmd);
      return true;
    } catch (e) {
      console.error('Error renaming Codex session:', e);
      return false;
    }
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

  _withDiscordResponseInstruction(prompt) {
    if (!prompt) return this.discordResponseInstruction.trim();
    if (prompt.includes('Gateway response style:')) return prompt;
    return `${prompt.trimEnd()}\n${this.discordResponseInstruction}`;
  }

  _shouldSkipGitRepoCheck(directory) {
    if (!directory) return false;

    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    let resolvedDir = directory;
    if (directory.startsWith('~')) {
      resolvedDir = path.join(os.homedir(), directory.substring(1));
    }
    return !fs.existsSync(path.join(resolvedDir, '.git'));
  }
}

module.exports = new CodexDriver();
