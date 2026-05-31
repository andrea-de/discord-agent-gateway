const { parsePrompts, stripDuplicatePrefix } = require('../parser');

class CodexDriver {
  getCommand() {
    return 'codex';
  }

  isInteractive() {
    return true;
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

  getArgs({ prompt, mode, isContinue, model, flags, directory }) {
    let args = [];

    if (isContinue) {
      // Resume session non-interactively
      args = ['exec', 'resume', '--last'];
      if (mode === 'yolo') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
      if (model) {
        args.push('-m', model);
      }
      args.push(prompt);
    } else {
      // Start fresh session non-interactively
      args = ['exec'];
      if (mode === 'yolo') {
        args.push('-a', 'never', '--dangerously-bypass-approvals-and-sandbox');
      } else {
        args.push('-a', 'untrusted');
      }
      if (model) {
        args.push('-m', model);
      }
      args.push(prompt);
    }

    if (directory) {
      args.push('-C', directory);
    }

    if (flags) {
      args.push(...this._parseFlags(flags));
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
}

module.exports = new CodexDriver();
