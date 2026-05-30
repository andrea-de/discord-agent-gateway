const { parsePrompts, stripDuplicatePrefix } = require('../parser');

class CodexDriver {
  getCommand() {
    return 'codex';
  }

  isInteractive() {
    return true;
  }

  getProviderUsageInfo(threadTokens, modelName) {
    const model = modelName || 'Default Codex Model';
    return `### 🧠 OpenAI Codex API Usage
* **Provider Model:** \`${model}\`
* **Current Thread Usage:** \`${threadTokens.toLocaleString()} tokens\`
* **Reset Interval:** Organization billing quotas typically reset monthly. Rate limits (RPM/TPM) reset every minute.
* **Quota Note:** Credit allocations are managed in your OpenAI developer dashboard.`;
  }

  getArgs({ prompt, mode, isContinue, model, flags }) {
    let args = [];

    if (isContinue) {
      // Resume session
      args = ['resume', '--last', '--no-alt-screen'];
      if (mode === 'yolo') {
        args.push('-a', 'never', '--dangerously-bypass-approvals-and-sandbox');
      } else {
        args.push('-a', 'untrusted');
      }
      if (model) {
        args.push('-m', model);
      }
      args.push(prompt);
    } else {
      // Start fresh session
      args = ['--no-alt-screen'];
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
