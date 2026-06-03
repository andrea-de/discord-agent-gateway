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
  recordUsage
} = require('./utils/state');

const { resolveGatewayAndProject } = require('./services/projectService');
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
        await processManager.startTask({
          thread: message.channel,
          tool: meta.tool,
          directory: meta.directory,
          mode: meta.mode,
          prompt: content,
          isContinue: !isInitialRun,
          previousHistoryText: isInitialRun ? '' : (meta.historyText || ''),
          model: meta.model,
          flags: meta.flags,
          sandbox: meta.sandbox
        });
      } catch (err) {
        await message.channel.send(`❌ **Failed to start or resume task:** ${err.message}`);
      }
    }
  }
});

// Clean up metadata when a thread is deleted
client.on('threadDelete', async (thread) => {
  if (threadMetadata.has(thread.id)) {
    console.log(`[Thread Delete] Cleaning up session metadata for thread ${thread.id}`);
    threadMetadata.delete(thread.id);
    saveMetadata();
  }
});

// Listen to processManager task ending to record the final conversation turn history and usage
processManager.on('taskEnded', (task) => {
  const meta = threadMetadata.get(task.threadId);
  if (meta) {
    const finalNewContent = task.driver.stripDuplicateHistory(task.previousHistoryText, task.processStdoutAccumulator);
    
    // Append the new content of this run to the session history
    meta.historyText = ((task.previousHistoryText || '') + '\n' + finalNewContent).trim();
    saveMetadata();
    console.log(`[Task Ended] Updated historyText for thread ${task.threadId}.`);

    // Parse and record token usage
    const logs = task.processStdoutAccumulator;
    const tokenMatch = logs.match(/tokens used\s*\n\s*([\d,]+)/i) || logs.match(/(\d+)\s*(?:total\s*)?tokens/i) || logs.match(/tokens?:\s*(\d+)/i);
    if (tokenMatch) {
      const tokenStr = tokenMatch[1].replace(/,/g, '');
      const tokens = parseInt(tokenStr, 10);
      if (!isNaN(tokens)) {
        recordUsage(task.tool, task.threadId, meta.model, tokens);
        console.log(`[Task Ended] Recorded usage: ${tokens} tokens for ${task.tool} (${meta.model}) in thread ${task.threadId}.`);
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
