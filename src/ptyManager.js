const pty = require('node-pty');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { stripAnsi } = require('./parser');

class PtyManager extends EventEmitter {
  constructor() {
    super();
    this.activeSessions = new Map(); // threadId -> SessionContext
  }

  /**
   * Spawns a new interactive PTY session.
   */
  async startSession({ thread, tool, directory, shell = '/bin/bash' }) {
    const threadId = thread.id;
    const os = require('os');
    
    // Resolve home directory
    if (directory.startsWith('~')) {
      directory = path.join(os.homedir(), directory.substring(1));
    }

    // Prepare environment
    const envPath = process.env.PATH || '';
    const homeLocalBin = path.join(os.homedir(), '.local', 'bin');
    const paths = envPath.split(path.delimiter);
    if (!paths.includes(homeLocalBin)) {
      paths.push(homeLocalBin);
    }
    const extendedPath = paths.join(path.delimiter);

    // Merge everything from process.env to ensure keys, tokens, and home paths are correct
    const spawnEnv = { 
      ...process.env,
      PATH: extendedPath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      HOME: os.homedir()
    };

    // Determine command to run
    let file = shell;
    let args = [];

    if (tool === 'gemini') {
      file = 'gemini';
      args = []; // Just start it interactive
    } else if (tool === 'agy') {
      file = 'agy';
      args = [];
    } else if (tool === 'codex') {
      file = 'codex';
      args = [];
    }

    // Spawn the PTY
    const ptyProcess = pty.spawn(file, args, {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: directory,
      env: spawnEnv
    });

    const sessionContext = {
      threadId,
      thread,
      tool,
      directory,
      pty: ptyProcess,
      startTime: new Date(),
      status: 'INTERACTIVE',
      outputBuffer: '',
      screen: this.createScreen(80, 24),
      screenDirty: false,
      lastOutputTime: Date.now(),
      flushTimer: null,
      displayMessage: null,
      sentMessages: [],
      fullLogFile: path.join(directory, `.gateway-pty-${tool}-${threadId}-${Date.now()}.log`)
    };

    this.activeSessions.set(threadId, sessionContext);

    fs.writeFileSync(sessionContext.fullLogFile, `--- PTY SESSION STARTED FOR ${tool.toUpperCase()} ---
Directory: ${directory}
Time: ${sessionContext.startTime.toISOString()}
--------------------------------------------------\n\n`);

    ptyProcess.onData((data) => {
      this.handlePtyData(sessionContext, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      this.handlePtyExit(sessionContext, exitCode, signal);
    });

    // Start periodic log flushing to Discord (every 1 second for higher responsiveness)
    sessionContext.flushTimer = setInterval(() => {
      this.flushToDiscord(sessionContext);
    }, 1000);

    return sessionContext;
  }

  handlePtyData(session, data) {
    session.outputBuffer += data;
    this.applyTerminalData(session, data);
    session.screenDirty = true;
    session.lastOutputTime = Date.now();
    
    // Also append to log file (stripping ANSI for the file)
    fs.appendFileSync(session.fullLogFile, stripAnsi(data));
  }

  async flushToDiscord(session) {
    if (!session.screenDirty) return;
    session.outputBuffer = '';
    session.screenDirty = false;

    const screenText = this.renderScreen(session.screen);
    if (!screenText) return;

    const formattedContent = '```\n' + screenText + '\n```';
    const pages = this.splitIntoPages(formattedContent);
    const page = pages[pages.length - 1];

    if (session.displayMessage) {
      try {
        await session.displayMessage.edit(page);
      } catch (err) {
        console.error('Failed to edit PTY display message:', err);
        session.displayMessage = null;
      }
    }

    if (!session.displayMessage) {
      try {
        session.displayMessage = await session.thread.send(page);
      } catch (err) {
        console.error('Failed to send PTY display message:', err);
      }
    }
  }

  createScreen(cols, rows) {
    return {
      cols,
      rows,
      cursorRow: 0,
      cursorCol: 0,
      lines: Array.from({ length: rows }, () => '')
    };
  }

  applyTerminalData(session, data) {
    const screen = session.screen;
    let i = 0;

    while (i < data.length) {
      const ch = data[i];

      if (ch === '\x1b') {
        i = this.consumeEscape(data, i, screen);
        continue;
      }

      if (ch === '\r') {
        screen.cursorCol = 0;
      } else if (ch === '\n') {
        this.newLine(screen);
      } else if (ch === '\b') {
        screen.cursorCol = Math.max(0, screen.cursorCol - 1);
      } else if (ch === '\t') {
        screen.cursorCol = Math.min(screen.cols - 1, screen.cursorCol + (8 - (screen.cursorCol % 8)));
      } else if (ch >= ' ') {
        this.writeChar(screen, ch);
      }

      i += 1;
    }
  }

  consumeEscape(data, start, screen) {
    const next = data[start + 1];
    if (!next) return start + 1;

    if (next === ']') {
      let i = start + 2;
      while (i < data.length) {
        if (data[i] === '\x07') return i + 1;
        if (data[i] === '\x1b' && data[i + 1] === '\\') return i + 2;
        i += 1;
      }
      return data.length;
    }

    if (next === '[') {
      let i = start + 2;
      while (i < data.length && !/[A-Za-z~]/.test(data[i])) {
        i += 1;
      }
      if (i >= data.length) return data.length;
      this.applyCsi(screen, data.substring(start + 2, i), data[i]);
      return i + 1;
    }

    return start + 2;
  }

  applyCsi(screen, rawParams, final) {
    const privateMode = rawParams.startsWith('?') || rawParams.startsWith('>');
    const cleanParams = rawParams.replace(/[?>]/g, '');
    const params = cleanParams.length
      ? cleanParams.split(';').map(value => parseInt(value, 10) || 0)
      : [];
    const first = params[0] || 1;

    if (privateMode && final !== 'J' && final !== 'K') return;

    if (final === 'A') {
      screen.cursorRow = Math.max(0, screen.cursorRow - first);
    } else if (final === 'B') {
      screen.cursorRow = Math.min(screen.rows - 1, screen.cursorRow + first);
    } else if (final === 'C') {
      screen.cursorCol = Math.min(screen.cols - 1, screen.cursorCol + first);
    } else if (final === 'D') {
      screen.cursorCol = Math.max(0, screen.cursorCol - first);
    } else if (final === 'G') {
      screen.cursorCol = Math.max(0, Math.min(screen.cols - 1, first - 1));
    } else if (final === 'H' || final === 'f') {
      screen.cursorRow = Math.max(0, Math.min(screen.rows - 1, (params[0] || 1) - 1));
      screen.cursorCol = Math.max(0, Math.min(screen.cols - 1, (params[1] || 1) - 1));
    } else if (final === 'J') {
      this.clearScreen(screen, params[0] || 0);
    } else if (final === 'K') {
      this.clearLine(screen, params[0] || 0);
    }
  }

  writeChar(screen, ch) {
    const line = screen.lines[screen.cursorRow] || '';
    const padded = line.padEnd(screen.cursorCol, ' ');
    screen.lines[screen.cursorRow] = (padded.substring(0, screen.cursorCol) + ch + padded.substring(screen.cursorCol + 1)).substring(0, screen.cols);
    screen.cursorCol += 1;
    if (screen.cursorCol >= screen.cols) {
      screen.cursorCol = 0;
      this.newLine(screen);
    }
  }

  newLine(screen) {
    if (screen.cursorRow >= screen.rows - 1) {
      screen.lines.shift();
      screen.lines.push('');
    } else {
      screen.cursorRow += 1;
    }
  }

  clearScreen(screen, mode) {
    if (mode === 2 || mode === 3) {
      screen.lines = Array.from({ length: screen.rows }, () => '');
      screen.cursorRow = 0;
      screen.cursorCol = 0;
    } else if (mode === 0) {
      screen.lines[screen.cursorRow] = (screen.lines[screen.cursorRow] || '').substring(0, screen.cursorCol);
      for (let row = screen.cursorRow + 1; row < screen.rows; row++) {
        screen.lines[row] = '';
      }
    } else if (mode === 1) {
      for (let row = 0; row < screen.cursorRow; row++) {
        screen.lines[row] = '';
      }
      screen.lines[screen.cursorRow] = (screen.lines[screen.cursorRow] || '').substring(screen.cursorCol);
    }
  }

  clearLine(screen, mode) {
    const line = screen.lines[screen.cursorRow] || '';
    if (mode === 2) {
      screen.lines[screen.cursorRow] = '';
    } else if (mode === 1) {
      screen.lines[screen.cursorRow] = line.substring(screen.cursorCol);
    } else {
      screen.lines[screen.cursorRow] = line.substring(0, screen.cursorCol);
    }
  }

  renderScreen(screen) {
    const lines = screen.lines.map(line => line.replace(/\s+$/g, ''));
    while (lines.length > 0 && lines[0] === '') lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    let rendered = lines.join('\n').replace(/```/g, '` ` `').trim();
    while (rendered.length > 1800 && lines.length > 1) {
      lines.shift();
      rendered = lines.join('\n').replace(/```/g, '` ` `').trim();
    }
    return rendered;
  }

  splitIntoPages(content) {
    const pages = [];
    const limit = 1900;
    // Strip trailing/leading whitespace and empty lines for cleaner Discord look
    let remaining = content.trim();

    if (!remaining) return [];

    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        pages.push(remaining);
        break;
      }

      // Try to split at a newline to avoid cutting in the middle of an ANSI code
      let splitIdx = remaining.lastIndexOf('\n', limit);
      if (splitIdx <= 0) splitIdx = limit;

      pages.push(remaining.substring(0, splitIdx));
      remaining = remaining.substring(splitIdx).trim();
    }
    return pages;
  }

  async sendInput(threadId, input) {
    const session = this.activeSessions.get(threadId);
    if (!session) return false;

    // Send input to PTY
    session.pty.write(input + '\r');
    return true;
  }

  async handlePtyExit(session, exitCode, signal) {
    if (session.flushTimer) clearInterval(session.flushTimer);
    
    // Final flush
    await this.flushToDiscord(session);

    const duration = Math.floor((Date.now() - session.startTime) / 1000);
    const msg = `🔌 **PTY Session Closed**\n* **Tool:** \`${session.tool}\`\n* **Exit Code:** \`${exitCode}\`\n* **Duration:** \`${duration}s\``;
    
    try {
      await session.thread.send(msg);
    } catch (e) {}

    this.activeSessions.delete(session.threadId);
  }

  async killSession(threadId) {
    const session = this.activeSessions.get(threadId);
    if (!session) return false;

    session.pty.kill();
    return true;
  }
}

module.exports = new PtyManager();
