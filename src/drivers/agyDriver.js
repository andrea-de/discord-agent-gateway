const { parsePrompts, stripDuplicatePrefix } = require('../parser');

class AgyDriver {
  getCommand() {
    return 'agy';
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
