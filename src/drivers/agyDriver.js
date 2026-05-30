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

  getArgs({ prompt, mode, isContinue, flags }) {
    let args = [];
    
    if (mode === 'yolo') {
      args = ['--print', prompt, '--dangerously-skip-permissions'];
    } else {
      args = ['--print', prompt];
    }
    
    if (isContinue) {
      args.push('--continue');
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
}

module.exports = new AgyDriver();
