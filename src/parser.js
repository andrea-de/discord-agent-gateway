/**
 * Parser utility for processing CLI tool outputs and detecting interactive prompts.
 */

/**
 * Strips ANSI escape codes from a string.
 * @param {string} str 
 * @returns {string}
 */
function stripAnsi(str) {
  if (!str) return '';
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Parses a CLI output string to check if it's requesting input,
 * and extracts multiple-choice selections or standard confirmations.
 * 
 * @param {string} text The accumulated stdout block
 * @returns {Object} Parse results
 */
function parsePrompts(text) {
  const clean = stripAnsi(text);
  const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  const choices = [];
  let hasEnter = false;
  let hasYesNo = false;
  let isAwaitingInput = false;

  // Look for "Press enter to continue" or "Press Enter..."
  // and "y/n" confirmation markers in the last 6 lines
  const tailStart = Math.max(0, lines.length - 6);
  for (let i = tailStart; i < lines.length; i++) {
    const line = lines[i];
    if (/press\s+enter\s+to\s+continue/i.test(line)) {
      hasEnter = true;
      isAwaitingInput = true;
    }
    if (/(?:\(|\[)y\/n(?:\)|\])/i.test(line)) {
      hasYesNo = true;
      isAwaitingInput = true;
    }
  }

  // Parse lines for numbered options (e.g. "1. Yes, continue", "› 2. No", etc.)
  // We check the last 15 lines of output for options
  const optionRegex = /^[›»●○\-*]*\s*[\[\((]?(\d+)[\]\)]?\.?\s+(.+)$/;
  const optionStart = Math.max(0, lines.length - 15);
  
  for (let i = optionStart; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(optionRegex);
    if (match) {
      const num = match[1];
      const desc = match[2].trim();
      
      // Avoid duplicate choice registrations
      if (!choices.some(c => c.value === num)) {
        // Simple heuristic to ignore lines that are clearly not option selections
        // (e.g., standard logs that start with numbers like timestamps or version strings)
        if (desc.length > 0 && desc.length < 60) {
          choices.push({ value: num, label: desc });
          isAwaitingInput = true;
        }
      }
    }
  }

  // General heuristic: if the CLI stdout ends with a common prompt prompt marker
  // (e.g. '?', '>', ':', or '›') and is paused, it's awaiting input
  if (lines.length > 0) {
    const lastLine = lines[lines.length - 1];
    // Check if it ends with prompt indicators but not standard code/paths
    // Restrict to short lines (< 80 characters) to avoid matching conversational prose questions
    if (/(\?|>|:|›)\s*$/.test(lastLine) && !lastLine.startsWith('http') && !lastLine.includes('/') && lastLine.length < 80) {
      isAwaitingInput = true;
    }
  }

  return {
    choices,
    hasEnter,
    hasYesNo,
    isAwaitingInput
  };
}

/**
 * Strips duplicate prefix (sequential matching lines) from newText that already exist in oldText.
 * Useful for continuing CLI sessions where the CLI reprints conversation logs.
 * 
 * @param {string} oldText The historical text printed in previous turns
 * @param {string} newText The complete accumulated stdout of the current process
 * @returns {string} The actual new content produced in the current turn
 */
function stripDuplicatePrefix(oldText, newText) {
  const defaultGreetings = [
    "Hello! I am Antigravity, your AI coding assistant. How can I help you today?",
    "Hello! I am Antigravity, your AI coding assistant. How can I help you with your coding tasks today?",
    "Hello! I am Antigravity, your AI coding assistant. How can I help you with your",
    "coding tasks today?",
    "Welcome to the Antigravity CLI. You are currently not signed in.",
    "Welcome to the Antigravity CLI."
  ];

  if (!oldText) {
    const lines = newText.split('\n');
    let skipCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.length === 0 || defaultGreetings.includes(trimmed)) {
        skipCount++;
      } else {
        break;
      }
    }
    return lines.slice(skipCount).join('\n');
  }
  
  const oldLines = oldText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  // Include standard greetings to ensure they get stripped too
  defaultGreetings.forEach(g => {
    if (!oldLines.includes(g)) {
      oldLines.push(g);
    }
  });

  const newLines = newText.split('\n');
  let skipCount = 0;
  
  for (let i = 0; i < newLines.length; i++) {
    const trimmedNewLine = newLines[i].trim();
    if (trimmedNewLine.length === 0) {
      skipCount++;
      continue;
    }
    
    if (oldLines.includes(trimmedNewLine)) {
      skipCount++;
    } else {
      break;
    }
  }
  
  return newLines.slice(skipCount).join('\n');
}

module.exports = {
  stripAnsi,
  parsePrompts,
  stripDuplicatePrefix
};
