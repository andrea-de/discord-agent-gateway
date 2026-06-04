require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, MessageType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const processManager = require('./processManager');
const ptyManager = require('./ptyManager');
const { registerCommands } = require('./commands');

const {
  setClient,
  threadMetadata,
  loadMetadata,
  saveMetadata,
  currentGateway,
} = require('./utils/state');

const { resolveGatewayAndProject, updateProjectDashboard, updateAllProjectDashboards } = require('./services/projectService');
const { initGatewayMessages, initSessionsPeriodicRefresh } = require('./services/statusUiService');
const { performGitPullAndRestart } = require('./services/restartService');
const { handleInteraction } = require('./handlers/interactionRouter');

// Ensure token configuration is present
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error('CRITICAL ERROR: Missing DISCORD_TOKEN or CLIENT_ID in environment.');
  process.exit(1);
}

// Initialize discord client with necessary intents
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Centralize the client in shared state
setClient(client);

// Robustness: Handle client and process-level errors to prevent crashes
client.on('error', (err) => {
  console.error('[Discord Client Error]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

// Perform initial thread metadata load
loadMetadata();

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}!`);
  
  // Programmatically update Bot Avatar and Server Icon if the generated file is present
  try {
    const avatarPath = '/home/andy/.gemini/antigravity-cli/brain/45f9541a-0df7-4353-a9d9-0fbafe91fad4/bot_avatar_1780183327794.png';
    if (fs.existsSync(avatarPath)) {
      console.log('Setting bot avatar and guild icon from generated image...');
      await client.user.setAvatar(avatarPath);
      console.log('Bot avatar updated successfully.');
      
      if (GUILD_ID) {
        try {
          const guild = await client.guilds.fetch(GUILD_ID);
          if (guild) {
            await guild.setIcon(avatarPath);
            console.log(`Guild icon for "${guild.name}" updated successfully.`);
          }
        } catch (guildErr) {
          console.warn('Could not update Guild icon (likely missing "Manage Server" bot permissions):', guildErr.message);
        }
      }
      
      // Rename the file to prevent repeatedly setting it on every single restart
      const usedPath = avatarPath + '.applied';
      fs.renameSync(avatarPath, usedPath);
      console.log('Renamed avatar file to prevent redundant updates.');
    }
  } catch (err) {
    console.error('Failed to set bot/server icons:', err);
  }

  // Register slash commands
  console.log('Registering slash commands...');
  const success = await registerCommands(TOKEN, CLIENT_ID, GUILD_ID);
  if (success) {
    console.log('Slash commands registered successfully.');
  } else {
    console.error('Failed to register slash commands.');
  }

  // Auto-provision Category and Gateway Channel on startup, and post online status message
  if (GUILD_ID) {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      if (guild) {
        const categoryName = `${currentGateway} GATEWAY`;
        const channelName = currentGateway.toLowerCase();
        
        // Fetch all channels from Discord API directly to prevent cache misses
        const channels = await guild.channels.fetch();
        
        // 1. Find or create the Category
        let category = channels.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
        if (!category) {
          try {
            category = await guild.channels.create({
              name: categoryName,
              type: ChannelType.GuildCategory
            });
            console.log(`Created category "${categoryName}" on startup.`);
          } catch (catErr) {
            console.warn(`Could not create category "${categoryName}" on startup:`, catErr.message);
          }
        }
        
        // 2. Find or create the Gateway text channel (e.g. #home)
        let gatewayChannel = channels.find(c => c.name === channelName && c.type === ChannelType.GuildText);
        if (!gatewayChannel) {
          try {
            const channelOpts = {
              name: channelName,
              type: ChannelType.GuildText,
              reason: `Gateway startup auto-provision`
            };
            gatewayChannel = await guild.channels.create(channelOpts);
            console.log(`Created gateway channel "#${channelName}" on startup.`);
          } catch (chanErr) {
            console.warn(`Could not create gateway channel "#${channelName}" on startup:`, chanErr.message);
          }
        } else if (gatewayChannel.parentId) {
          try {
            await gatewayChannel.setParent(null);
            console.log(`Moved gateway channel "#${channelName}" to root text channels on startup.`);
          } catch (moveErr) {
            console.warn(`Could not move gateway channel "#${channelName}" to root:`, moveErr.message);
          }
        }
        
        // 3. Post online message
        if (gatewayChannel) {
          await initGatewayMessages(gatewayChannel);
          await initSessionsPeriodicRefresh(gatewayChannel);
        }

        // 4. Refresh all project dashboards in the category on boot
        await updateAllProjectDashboards(guild);
      }
    } catch (err) {
      console.warn('Startup category/channel auto-provisioning failed:', err.message);
    }
  }
  
  console.log('Gateway is ready to receive tasks.');
  performSandboxDiagnostics();
});

// Delegate all interactions (commands, buttons, modals, autocompletes) to the router
client.on('interactionCreate', handleInteraction);

/**
 * Handle message replies inside threads to redirect standard user replies to process stdin
 * or to spawn continuation runs for completed tasks.
 */
client.on('messageCreate', async (message) => {
  // Automatically delete thread creation system notifications to keep parent channels clean
  if (message.type === MessageType.ThreadCreated) {
    try {
      await message.delete();
    } catch (e) {
      console.warn('Failed to delete thread creation system message:', e.message);
    }
    return;
  }

  // Ignore bots and webhooks
  if (message.author.bot || message.webhookId) return;

  // Verify we are inside a thread
  if (!message.channel.isThread()) return;

  // Verify target gateway for this thread to prevent multiple bot instances from responding
  const { gateway } = resolveGatewayAndProject(message.channel);
  if (gateway && gateway !== currentGateway) {
    return; // Ignore if this thread belongs to a different gateway
  }

  const threadId = message.channel.id;
  const ptySession = ptyManager.activeSessions.get(threadId);
  const task = processManager.activeTasks.get(threadId);
  const content = message.content.trim();
  if (content.length === 0) return;

  // 1. If it's a PTY Session
  if (ptySession) {
    try {
      await message.react('⌨️');
      await ptyManager.sendInput(threadId, content);
    } catch (e) {}
    return;
  }

  console.log(`[Thread Message] ID: ${threadId}, Author: ${message.author.tag}, Content: "${content}", ActiveTask: ${!!task}`);

  // 2. If there is an active agent task running in this thread (Headless)
  if (task) {
    // React to confirm we are piping this message to stdin
    try {
      await message.react('📥');
    } catch (e) {
      // Permission issues reacting, ignore
    }

    const success = await processManager.sendInput(threadId, content);
    if (!success) {
      try {
        await message.reply('❌ Failed to route input to active agent process.');
      } catch (e) {}
    }
  } else {
    // Check if this thread has historical metadata for conversation resumption or initial interactive run
    const meta = threadMetadata.get(threadId);
    if (meta) {
      const isInitialRun = meta.hasStarted === false;

      try {
        await message.react('⚙️');
      } catch (e) {}

      if (isInitialRun) {
        await message.channel.send(`🚀 **Starting agent session...**`);
        
        // Attempt to rename the thread to reflect the first prompt
        try {
          const toolDisplay = meta.tool === 'agy' ? 'antigravity' : meta.tool;
          const newName = `[${toolDisplay}] ${content.substring(0, 75)}`.trim();
          await message.channel.setName(newName);
        } catch (renameErr) {
          console.warn('Failed to rename thread:', renameErr.message);
        }

        // Update metadata status
        meta.hasStarted = true;
        saveMetadata();
      } else {
        await message.channel.send(`🔄 **Resuming conversation session...**`);
      }

      try {
        const taskContext = await processManager.startTask({
          thread: message.channel,
          tool: meta.tool,
          directory: meta.directory,
          mode: meta.mode,
          prompt: content,
          isContinue: !isInitialRun,
          previousHistoryText: isInitialRun ? '' : (meta.historyText || ''),
          model: meta.model,
          flags: meta.flags,
          sandbox: meta.sandbox,
          sessionId: meta.sessionId
        });

        if (!meta.sessionId && taskContext) {
          setTimeout(async () => {
            try {
              const resolvedSessionId = taskContext.driver.findSessionId(taskContext.directory);
              if (resolvedSessionId) {
                meta.sessionId = resolvedSessionId;
                processManager.renameLogDir(message.channel.id, resolvedSessionId);
                const { updateThreadControlMessage } = require('./handlers/buttonHandlers');
                await updateThreadControlMessage(message.channel, meta);
                saveMetadata();
                console.log(`[Task Started] Automatically resolved and locked sessionId ${resolvedSessionId} for thread ${message.channel.id}`);
              }
            } catch (err) {
              console.error('Failed to auto-resolve sessionId on task startup:', err);
            }
          }, 1500);
        }
      } catch (err) {
        await message.channel.send(`❌ **Failed to start or resume task:** ${err.message}`);
      }
    }
  }
});

// Helper to handle thread lifecycle updates on the project dashboard
async function handleThreadChange(thread) {
  const parent = thread.parent;
  if (!parent) return;

  // Verify parent channel is a project channel under a Gateway Category
  const parentCategory = parent.parent;
  if (parentCategory && parentCategory.name.endsWith(' GATEWAY')) {
    const { gateway } = resolveGatewayAndProject(parent);
    if (gateway && gateway === currentGateway) {
      await updateProjectDashboard(parent);
    }
  }
}

// Update dashboard list when a thread is created
client.on('threadCreate', async (thread) => {
  await handleThreadChange(thread);
});

// Clean up metadata and update dashboard when a thread is deleted
client.on('threadDelete', async (thread) => {
  const threadId = thread.id;
  let activeLogPath = null;

  // Kill active agent task if any
  const task = processManager.activeTasks.get(threadId);
  if (task) {
    if (task.fullLogFile) activeLogPath = task.fullLogFile;
    try {
      console.log(`[Thread Delete] Killing active task for deleted thread ${threadId}`);
      await processManager.killTask(threadId);
    } catch (e) {
      console.error(`Failed to kill task on thread deletion:`, e);
    }
  }

  // Kill active PTY session if any
  const ptySession = ptyManager.activeSessions.get(threadId);
  if (ptySession) {
    if (ptySession.fullLogFile) activeLogPath = ptySession.fullLogFile;
    try {
      console.log(`[Thread Delete] Killing active PTY session for deleted thread ${threadId}`);
      await ptyManager.killSession(threadId);
    } catch (e) {
      console.error(`Failed to kill PTY session on thread deletion:`, e);
    }
  }

  // Clean up any log files associated with this thread
  const logDir = '/tmp/discord-agent-gateway/logs';
  try {
    if (fs.existsSync(logDir) && fs.statSync(logDir).isDirectory()) {
      const files = fs.readdirSync(logDir);
      for (const file of files) {
        if (file.includes(`-${threadId}-`) && file.endsWith('.log')) {
          try {
            fs.unlinkSync(path.join(logDir, file));
            console.log(`[Thread Delete] Cleaned up log file: ${file}`);
          } catch (err) {
            console.error(`[Thread Delete] Failed to delete log file ${file}:`, err.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Thread Delete] Error scanning directory for logs:', err);
  }

  // Fallback delete of activeLogPath
  if (activeLogPath && fs.existsSync(activeLogPath)) {
    try {
      fs.unlinkSync(activeLogPath);
      console.log(`[Thread Delete] Deleted active log file: ${activeLogPath}`);
    } catch (e) {
      console.error(`[Thread Delete] Failed to delete active log file ${activeLogPath}:`, e.message);
    }
  }

  if (threadMetadata.has(threadId)) {
    console.log(`[Thread Delete] Cleaning up session metadata for thread ${threadId}`);
    threadMetadata.delete(threadId);
    saveMetadata();
  }
  await handleThreadChange(thread);
});

// Update dashboard list when a thread is archived or unarchived
client.on('threadUpdate', async (oldThread, newThread) => {
  if (oldThread.archived !== newThread.archived) {
    await handleThreadChange(newThread);
  }
});

processManager.on('taskEnded', async (task) => {
  const meta = threadMetadata.get(task.threadId);
  if (meta) {
    let sessionIdChanged = false;
    if (!meta.sessionId) {
      const resolvedSessionId = task.driver.findSessionId(task.directory);
      if (resolvedSessionId) {
        meta.sessionId = resolvedSessionId;
        processManager.renameLogDir(task.threadId, resolvedSessionId);
        console.log(`[Task Ended] Resolved and locked sessionId ${resolvedSessionId} for thread ${task.threadId}`);
        sessionIdChanged = true;
      }
    }
    const hideExecDetails = meta ? meta.hideExecDetails : false;
    const finalNewContent = task.driver.stripDuplicateHistory(task.previousHistoryText, task.processStdoutAccumulator, hideExecDetails);
    
    // Append the new content of this run to the session history
    meta.historyText = ((task.previousHistoryText || '') + '\n' + finalNewContent).trim();
    saveMetadata();
    console.log(`[Task Ended] Updated historyText for thread ${task.threadId}.`);

    if (sessionIdChanged) {
      try {
        const { updateThreadControlMessage } = require('./handlers/buttonHandlers');
        const client = require('./utils/state').getClient();
        const thread = await client.channels.fetch(task.threadId);
        if (thread) {
          await updateThreadControlMessage(thread, meta);
        }
      } catch (err) {
        console.error('Failed to update control message after resolving session ID:', err);
      }
    }
  }
});

// Perform a quick check on startup to diagnose sandbox issues
async function performSandboxDiagnostics() {
  const { exec } = require('child_process');
  
  exec('codex --version', (err, stdout, stderr) => {
    if (err) {
      console.warn('⚠️  [Diagnostics] Codex CLI does not seem to be installed or available in PATH.');
      return;
    }
    
    exec('codex sandbox true', (sandboxErr, sandboxStdout, sandboxStderr) => {
      if (sandboxErr) {
        console.warn('\n======================================================================');
        console.warn('⚠️  [Diagnostics] Codex Linux sandbox (Bubblewrap) is failing on this host!');
        console.warn(`Reason: ${sandboxStderr.trim()}`);
        console.warn('\nTo resolve this issue, please do one of the following:');
        console.warn('1. Run tasks with the slash command option \`sandbox: Danger: Full Access\` (skips bubblewrap).');
        console.warn('2. Disable unprivileged user namespace restrictions on your host system:');
        console.warn('   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0');
        console.warn('3. (Recommended for Ubuntu/Debian) Configure AppArmor to allow Bubblewrap:');
        console.warn('   See the README Troubleshooting section for instructions.');
        console.warn('======================================================================\n');
      } else {
        console.log('✅ [Diagnostics] Codex Linux sandbox (Bubblewrap) test passed successfully.');
      }
    });
  });
}

// Bot token authorization login
client.login(TOKEN);

// Listen to keyboard press events on standard input for console shortcut 'r'
if (process.stdin.isTTY) {
  try {
    const readline = require('readline');
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', async (str, key) => {
      if (key.ctrl && key.name === 'c') {
        process.exit();
      } else if (key.name === 'r') {
        console.log('\n🔄 Keyboard shortcut [r] detected! Triggering git pull and restart...');
        await performGitPullAndRestart();
      }
    });
    console.log('⌨️  Console keyboard listener active. Press [r] to git pull and restart, or [Ctrl+C] to exit.');
  } catch (err) {
    console.warn('Failed to initialize raw stdin console key listener:', err.message);
  }
}
