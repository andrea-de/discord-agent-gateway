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

    const spawnEnv = { 
      ...process.env,
      PATH: extendedPath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
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
      lastOutputTime: Date.now(),
      flushTimer: null,
      sentMessages: [],
      fullLogFile: path.join(directory, `.gateway-pty-${tool}-${Date.now()}.log`)
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
    session.lastOutputTime = Date.now();
    
    // Also append to log file (stripping ANSI for the file)
    fs.appendFileSync(session.fullLogFile, stripAnsi(data));
  }

  async flushToDiscord(session) {
    if (!session.outputBuffer) return;

    const rawContent = session.outputBuffer;
    session.outputBuffer = ''; // Clear buffer immediately

    // Use Discord's ANSI code block for coloring
    // We wrap it in ```ansi
    const formattedContent = '```ansi\n' + this.sanitizeAnsiForDiscord(rawContent) + '\n```';

    const pages = this.splitIntoPages(formattedContent);

    for (const page of pages) {
      try {
        await session.thread.send(page);
      } catch (err) {
        console.error('Failed to send PTY output page:', err);
      }
    }
  }

  /**
   * Basic sanitizer to keep some colors but remove complex PTY control sequences
   * that Discord doesn't support or that would break the layout.
   */
  sanitizeAnsiForDiscord(text) {
    // Discord supports basic colors but not cursor movement, clears, etc.
    // For now, let's just strip everything but the basic color codes
    // A more advanced version would map colors but strip cursor movements.
    return text.replace(/\x1B\[[0-9;]*[JKmsuH]/g, (match) => {
      if (match.endsWith('m')) return match; // Keep color/style codes
      return ''; // Strip others
    });
  }

  splitIntoPages(content) {
    const pages = [];
    const limit = 1900;
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        pages.push(remaining);
        break;
      }
      pages.push(remaining.substring(0, limit));
      remaining = remaining.substring(limit);
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
