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
