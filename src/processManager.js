const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { stripAnsi } = require('./parser');
const { getDriver } = require('./drivers');

class ProcessManager extends EventEmitter {
  constructor() {
    super();
    this.activeTasks = new Map(); // threadId -> TaskContext
  }

  /**
   * Helper to format millisecond duration into human readable string
   */
  formatDuration(ms) {
    const totalSecs = Math.floor(ms / 1000);
    const hours = Math.floor(totalSecs / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;
    
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(' ');
  }

  /**
   * Spawns a new agent process for a given Discord thread.
   */
  async startTask({ thread, tool, directory, mode, prompt, isContinue = false, previousHistoryText = '', model, flags, sandbox }) {
    const threadId = thread.id;
    
    // Resolve home directory tilde if present
    const os = require('os');
    if (directory.startsWith('~')) {
      directory = path.join(os.homedir(), directory.substring(1));
    }
    
    // 1. Validate/Create directory
    if (!fs.existsSync(directory)) {
      try {
        fs.mkdirSync(directory, { recursive: true });
        console.log(`Created missing directory: ${directory}`);
      } catch (err) {
        throw new Error(`Failed to create directory "${directory}": ${err.message}`);
      }
    }
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) {
      throw new Error(`Path "${directory}" is not a directory.`);
    }
    
    // Check if git repo
    const isGit = fs.existsSync(path.join(directory, '.git'));
    if (!isGit) {
      // Post warning but proceed!
      setTimeout(async () => {
        try {
          await thread.send('⚠️ **Notice:** This directory is not a git repository (no `.git` directory found). Version control features may be inactive.');
        } catch (e) {}
      }, 500);
    }

    // Resolve driver
    const driver = getDriver(tool);

    // 2. Prepare command and arguments
    const cmd = driver.getCommand();
    const args = driver.getArgs({ prompt, mode, isContinue, model, flags, directory, sandbox });

    // 3. Spawn process
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
      ...driver.getEnv({ model })
    };

    const child = spawn(cmd, args, {
      cwd: directory,
      env: spawnEnv
    });

    // For agy, codex, and gemini, stdin must be closed to prevent them from blocking/waiting on EOF
    if (tool === 'agy' || tool === 'codex' || tool === 'gemini') {
      child.stdin.end();
    }

    const taskContext = {
      threadId,
      thread,
      tool,
      directory,
      mode,
      prompt,
      model,
      flags,
      sandbox,
      driver,
      process: child,
      startTime: new Date(),
      status: 'RUNNING',
      stdoutBuffer: '',
      promptBuffer: '',
      lastOutputTime: Date.now(),
      lastLogMessage: null,
      promptMessage: null,
      controlMessage: null,
      previousHistoryText,
      processStdoutAccumulator: '',
      flushedNewContentLength: 0,
      sentMessages: [],
      lastFlushedContent: '',
      exitCode: null,
      inactivityTimer: null,
      flushTimer: null,
      fullLogFile: path.join(directory, `.gateway-${tool}-${threadId}-${Date.now()}.log`)
    };

    this.activeTasks.set(threadId, taskContext);

    // Initialize clean log file in the project
    fs.writeFileSync(taskContext.fullLogFile, `--- SESSION STARTED FOR ${(tool === 'agy' ? 'antigravity' : tool).toUpperCase()} ---
Directory: ${directory}
Mode: ${mode}
Prompt: ${prompt}
Time: ${taskContext.startTime.toISOString()}
--------------------------------------------------\n\n`);

    // Setup stdout / stderr stream readers
    child.stdout.on('data', (data) => {
      this.handleProcessOutput(taskContext, data, false);
    });

    child.stderr.on('data', (data) => {
      this.handleProcessOutput(taskContext, data, true);
    });

    child.on('close', (code, signal) => {
      this.handleProcessClose(taskContext, code, signal);
    });

    child.on('error', (err) => {
      this.handleProcessError(taskContext, err);
    });

    // Start periodic log flushing to Discord (every 1.5 seconds)
    taskContext.flushTimer = setInterval(() => {
      this.flushLogsToDiscord(taskContext);
    }, 1500);

    const controlRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`process:stop:${threadId}`)
        .setLabel('Stop Request')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🛑')
    );

    try {
      taskContext.controlMessage = await thread.send({
        content: '🟢 **Request running.**',
        components: [controlRow]
      });
    } catch (err) {
      console.error('Failed to send process control message:', err);
    }

    return taskContext;
  }

  /**
   * Handles stdout/stderr data from child process.
   */
  handleProcessOutput(task, rawData, isStderr) {
    const rawStr = rawData.toString();
    const cleanStr = stripAnsi(rawStr);
    
    // Write raw/cleaned to workspace log file
    fs.appendFileSync(task.fullLogFile, cleanStr);

    task.processStdoutAccumulator = (task.processStdoutAccumulator || '') + cleanStr;
    task.promptBuffer += cleanStr;
    task.lastOutputTime = Date.now();


    // If YOLO mode or the tool is non-interactive, we do not need prompt parsing
    if (task.mode === 'yolo' || !task.driver.isInteractive()) {
      return;
    }

    // Reset prompt detection timer (debounce)
    if (task.inactivityTimer) {
      clearTimeout(task.inactivityTimer);
    }

    task.inactivityTimer = setTimeout(() => {
      this.checkForPrompt(task);
    }, 1200);
  }

  /**
   * Flushes accumulated stdoutBuffer logs into the Discord thread.
   * Emulates a rolling visual terminal block.
   */
  async flushLogsToDiscord(task) {
    const newContent = task.driver.stripDuplicateHistory(task.previousHistoryText, task.processStdoutAccumulator || '');
    if (!newContent.trim()) return;
    if (newContent === task.lastFlushedContent) return;
    task.lastFlushedContent = newContent;

    const pages = [];
    let remaining = newContent;
    const limit = 3700;

    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        pages.push(remaining);
        break;
      }

      let splitIdx = remaining.lastIndexOf('\n\n', limit);
      if (splitIdx <= 0) {
        splitIdx = remaining.lastIndexOf('\n', limit);
      }
      if (splitIdx <= 0) {
        splitIdx = remaining.lastIndexOf(' ', limit);
      }
      if (splitIdx <= 0) {
        splitIdx = limit;
      }

      let pageContent = remaining.substring(0, splitIdx);
      let nextContent = remaining.substring(splitIdx);

      // Check if we are inside a code block (odd count of triple backticks)
      const backtickCount = (pageContent.match(/```/g) || []).length;
      if (backtickCount % 2 !== 0) {
        pageContent += '\n```';
        nextContent = '```diff\n' + nextContent.replace(/^\n+/, '');
      }

      pages.push(pageContent);
      remaining = nextContent;
    }

    let authorName = 'Agent CLI';
    let authorIcon = 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/Google_Gemini_logo.svg/120px-Google_Gemini_logo.svg.png';

    if (task.tool === 'agy') {
      authorName = 'Antigravity CLI';
    } else if (task.tool === 'codex') {
      authorName = 'Codex CLI';
      authorIcon = 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/OpenAI_Logo.svg/120px-OpenAI_Logo.svg.png';
    } else if (task.tool === 'gemini') {
      authorName = 'Gemini CLI';
    }

    if (!task.sentMessages) {
      task.sentMessages = [];
    }

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (page.trim().length === 0) continue;

      const embed = new EmbedBuilder()
        .setColor('#2b2d31') // Premium Slate Gray
        .setAuthor({ name: authorName, iconURL: authorIcon })
        .setDescription(page);

      try {
        if (task.sentMessages[i]) {
          await task.sentMessages[i].edit({ embeds: [embed] });
        } else {
          const sentMsg = await task.thread.send({ embeds: [embed] });
          task.sentMessages.push(sentMsg);
        }
      } catch (err) {
        console.error(`Failed to flush log page ${i} to Discord:`, err);
        try {
          if (task.sentMessages[i]) {
            await task.sentMessages[i].edit({ content: page, embeds: [] });
          } else {
            const sentMsg = await task.thread.send({ content: page });
            task.sentMessages.push(sentMsg);
          }
        } catch (subErr) {
          console.error('Fallback send failed:', subErr);
        }
      }
    }
  }

  /**
   * Scans promptBuffer for option menus or input breakpoints.
   */
  async checkForPrompt(task) {
    if (task.status !== 'RUNNING') return;

    const parseResult = task.driver.parseInteractivePrompts(task.promptBuffer);
    if (!parseResult.isAwaitingInput) return;

    // Clear promptBuffer since we've parsed the prompt
    task.promptBuffer = '';

    // Transition state
    task.status = parseResult.choices.length > 0 || parseResult.hasYesNo || parseResult.hasEnter
      ? 'PAUSED_REVIEW'
      : 'AWAITING_INPUT';

    // Flush any remaining logs first
    await this.flushLogsToDiscord(task);

    // Build interactive component buttons
    const actionRows = [];
    let buttonRow = new ActionRowBuilder();

    if (parseResult.choices.length > 0) {
      // Numerical options
      parseResult.choices.forEach((choice, index) => {
        // Map common phrases to premium colors
        let style = ButtonStyle.Secondary;
        const text = choice.label.toLowerCase();
        
        if (text.includes('yes') || text.includes('continue') || text.includes('proceed') || text.includes('apply')) {
          style = ButtonStyle.Success;
        } else if (text.includes('no') || text.includes('quit') || text.includes('cancel') || text.includes('abort')) {
          style = ButtonStyle.Danger;
        } else if (index === 0) {
          style = ButtonStyle.Primary;
        }

        const button = new ButtonBuilder()
          .setCustomId(`choice:${choice.value}`)
          .setLabel(`${choice.value}. ${choice.label.substring(0, 50)}`)
          .setStyle(style);

        // Action rows contain max 5 buttons
        if (buttonRow.components.length >= 5) {
          actionRows.push(buttonRow);
          buttonRow = new ActionRowBuilder();
        }
        buttonRow.addComponents(button);
      });
    } else if (parseResult.hasYesNo) {
      // Yes / No options
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId('choice:y')
          .setLabel('Yes (y)')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('choice:n')
          .setLabel('No (n)')
          .setStyle(ButtonStyle.Danger)
      );
    } else if (parseResult.hasEnter) {
      // Enter option
      buttonRow.addComponents(
        new ButtonBuilder()
          .setCustomId('choice:enter')
          .setLabel('Continue (Enter)')
          .setStyle(ButtonStyle.Primary)
      );
    }

    if (buttonRow.components.length > 0) {
      actionRows.push(buttonRow);
    }

    // Send the prompt message to Discord
    let content = '### ⏳ Agent Interaction Required\nPlease choose an option below to proceed:';
    if (task.status === 'AWAITING_INPUT') {
      content = '### ⌨️ Gateway Awaiting Input\nThe agent is waiting for terminal text input. Please type your reply directly in this thread.';
    }

    try {
      const msgOpts = { content };
      if (actionRows.length > 0) {
        msgOpts.components = actionRows;
      }
      task.promptMessage = await task.thread.send(msgOpts);
    } catch (err) {
      console.error('Failed to send prompt message:', err);
    }
  }

  /**
   * Sends text input straight to the process stdin.
   */
  async sendInput(threadId, rawInput) {
    const task = this.activeTasks.get(threadId);
    if (!task) return false;

    // Check if task can accept input
    if (task.status !== 'PAUSED_REVIEW' && task.status !== 'AWAITING_INPUT' && task.status !== 'RUNNING') {
      return false;
    }

    // If we had a prompt message with buttons, disable them
    if (task.promptMessage) {
      try {
        const disabledRows = task.promptMessage.components.map(row => {
          const newRow = ActionRowBuilder.from(row.toJSON());
          newRow.components.forEach(btn => btn.setDisabled(true));
          return newRow;
        });
        await task.promptMessage.edit({ components: disabledRows });
      } catch (err) {
        console.error('Failed to disable buttons:', err);
      }
      task.promptMessage = null;
    }

    // Write input to stdin (handles both normal replies and button clicks)
    const normalizedInput = rawInput === 'enter' ? '\n' : `${rawInput}\n`;
    task.process.stdin.write(normalizedInput);

    // Reset status back to RUNNING
    task.status = 'RUNNING';
    task.promptBuffer = ''; // Reset prompt buffer for new prompts

    // Append user input to log file
    fs.appendFileSync(task.fullLogFile, `\n>>> [USER INPUT]: ${rawInput}\n\n`);

    return true;
  }

  /**
   * Forcefully terminates a running agent.
   */
  async killTask(threadId, options = {}) {
    const { archiveThread = false } = options;
    const task = this.activeTasks.get(threadId);
    if (!task) return false;

    // Clear timers
    if (task.inactivityTimer) clearTimeout(task.inactivityTimer);
    if (task.flushTimer) clearInterval(task.flushTimer);

    // Terminate process
    task.status = 'KILLED';
    task.process.kill('SIGTERM');
    
    // Wait a brief moment to verify death, otherwise SIGKILL
    setTimeout(() => {
      try {
        if (task.process && !task.process.killed) {
          task.process.kill('SIGKILL');
        }
      } catch (e) {}
    }, 1000);

    // Notify thread
    await this.flushLogsToDiscord(task);
    const terminationMessage = archiveThread
      ? '🛑 **Task process forcefully terminated by user. Thread archiving...**'
      : '🛑 **Task process stopped by user.**';
    await task.thread.send(terminationMessage);
    await this.clearControlButton(task, '🛑 **Request stopped.**');

    if (archiveThread) {
      // Archive and lock Discord Thread
      try {
        await task.thread.edit({ archived: true, locked: true });
      } catch (err) {
        console.error('Failed to archive thread:', err);
      }
    }

    fs.appendFileSync(task.fullLogFile, `\n--- SESSION FORCEFULLY TERMINATED BY USER ---`);
    this.activeTasks.delete(threadId);
    return true;
  }

  async clearControlButton(task, content) {
    if (!task.controlMessage) return;

    try {
      await task.controlMessage.edit({ content, components: [] });
    } catch (err) {
      console.error('Failed to clear process control button:', err);
    }
    task.controlMessage = null;
  }

  /**
   * Exports the thread message history to a local Markdown log.
   */
  async exportTask(threadId) {
    const task = this.activeTasks.get(threadId);
    if (!task) return null;

    const exportFile = path.join(task.directory, `gateway-export-${task.tool}-${threadId}.md`);
    
    try {
      // Fetch messages from thread
      const messages = await task.thread.messages.fetch({ limit: 100 });
      const sortedMessages = [...messages.values()].reverse();

      let markdownContent = `# Discord Chat-Ops Session Export
* **Tool:** ${(task.tool === 'agy' ? 'antigravity' : task.tool).toUpperCase()}
* **Directory:** \`${task.directory}\`
* **Mode:** ${task.mode}
* **Original Prompt:** ${task.prompt}
* **Export Time:** ${new Date().toISOString()}
* **Execution Duration:** ${this.formatDuration(Date.now() - task.startTime)}

---

## Conversation Log

`;

      sortedMessages.forEach(msg => {
        const timeStr = msg.createdAt.toISOString();
        const author = msg.author.bot ? `🤖 **Bot (${msg.author.username})**` : `👤 **User (${msg.author.username})**`;
        markdownContent += `### [${timeStr}] ${author}\n${msg.content}\n\n`;
      });

      fs.writeFileSync(exportFile, markdownContent);
      return exportFile;
    } catch (err) {
      console.error('Export failed:', err);
      return null;
    }
  }

  /**
   * Handles child process termination event.
   */
  async handleProcessClose(task, code, signal) {
    if (task.status === 'KILLED') return; // Already handled by killTask

    // Clear timers
    if (task.inactivityTimer) clearTimeout(task.inactivityTimer);
    if (task.flushTimer) clearInterval(task.flushTimer);

    task.exitCode = code;
    task.status = code === 0 ? 'COMPLETED' : 'FAILED';

    // Flush any remaining stdout logs
    await this.flushLogsToDiscord(task);

    const durationStr = this.formatDuration(Date.now() - task.startTime);
    let closingMsg = '';

    if (code === 0) {
      closingMsg = `✅ **Agent execution completed successfully!**\n* **Duration:** ${durationStr}\n* **Log File:** \`${task.fullLogFile}\``;
      
      // Clear lockout topic on success if it was previously set to LOCKED OUT
      if (task.thread.parent && typeof task.thread.parent.setTopic === 'function') {
        try {
          const topic = task.thread.parent.topic;
          if (topic && topic.includes('LOCKED OUT')) {
            await task.thread.parent.setTopic(`🟢 Active Project Workspace.`);
          }
        } catch (topicErr) {}
      }
    } else {
      closingMsg = `❌ **Agent execution failed!**\n* **Exit Code:** ${code}\n* **Signal:** ${signal || 'none'}\n* **Duration:** ${durationStr}\n* **Log File:** \`${task.fullLogFile}\``;
      
      // Catch individual quota exhaustion / RESOURCE_EXHAUSTED / 429 error logs
      if (task.processStdoutAccumulator) {
        const output = task.processStdoutAccumulator;
        const hasQuotaError = output.includes('Individual quota reached') || 
                              output.includes('RESOURCE_EXHAUSTED') || 
                              output.includes('Quota exceeded') ||
                              output.includes('429');
        
        if (hasQuotaError) {
          const resetMatch = output.match(/Resets in\s*([0-9a-zA-Z\s]+)/i) || 
                             output.match(/reset[^\n]*in\s*([0-9a-zA-Z\s]+)/i);
          const resetsIn = resetMatch ? resetMatch[1].trim() : 'unknown duration';
          const toolDisplay = (task.tool === 'agy' ? 'antigravity' : task.tool).toUpperCase();
          
          const quotaWarning = `⚠️ **Lockout Warning:** Individual usage/turn quota limit has been exhausted (code 429).\n* **Tool:** ${toolDisplay}\n* **Status:** **LOCKED OUT**\n* **Estimated Reset:** Resets in \`${resetsIn}\`\n\n*Note: This is your client-level / Google One IDE chat entitlement limit. While this limit is active, the underlying agent CLI will be locked out and reject all incoming prompts.*`;
          
          closingMsg = `${quotaWarning}\n\n${closingMsg}`;
          
          // Attempt to update parent channel topic to make the lockout visible at first glance
          if (task.thread.parent && typeof task.thread.parent.setTopic === 'function') {
            try {
              await task.thread.parent.setTopic(`⚠️ LOCKED OUT: Quota reached for ${toolDisplay}. Resets in ${resetsIn}`);
            } catch (topicErr) {
              console.warn(`Could not update channel topic for #${task.thread.parent.name}:`, topicErr.message);
            }
          }
        }
      }
    }

    try {
      await task.thread.send(closingMsg);
      await this.clearControlButton(task, code === 0 ? '✅ **Request complete.**' : '❌ **Request failed.**');
      // Clean up buttons if any prompt message exists
      if (task.promptMessage) {
        try {
          const disabledRows = task.promptMessage.components.map(row => {
            const newRow = ActionRowBuilder.from(row.toJSON());
            newRow.components.forEach(btn => btn.setDisabled(true));
            return newRow;
          });
          await task.promptMessage.edit({ components: disabledRows });
        } catch (e) {}
      }
    } catch (err) {
      console.error('Failed to send closing message:', err);
    }

    fs.appendFileSync(task.fullLogFile, `\n--- SESSION ENDED ---
Status: ${task.status}
Exit Code: ${code}
Signal: ${signal}
Duration: ${durationStr}\n`);

    this.activeTasks.delete(task.threadId);
    this.emit('taskEnded', task);
  }

  /**
   * Handles process error (e.g. command not found).
   */
  async handleProcessError(task, err) {
    if (task.inactivityTimer) clearTimeout(task.inactivityTimer);
    if (task.flushTimer) clearInterval(task.flushTimer);

    task.status = 'FAILED';
    const durationStr = this.formatDuration(Date.now() - task.startTime);

    const errMsg = `💥 **Process Error occurred!**\n* **Message:** ${err.message}\n* **Duration:** ${durationStr}`;
    
    try {
      await task.thread.send(errMsg);
      await this.clearControlButton(task, '❌ **Request failed.**');
    } catch (discordErr) {
      console.error('Failed to send error message:', discordErr);
    }

    fs.appendFileSync(task.fullLogFile, `\n--- PROCESS ERROR ---\n${err.stack}\n`);
    this.activeTasks.delete(task.threadId);
  }
}

module.exports = new ProcessManager();
