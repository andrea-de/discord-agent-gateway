require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const processManager = require('./processManager');
const { registerCommands } = require('./commands');

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

// Thread metadata session persistence map
const METADATA_FILE = path.join(__dirname, '../.thread-metadata.json');
let threadMetadata = new Map();

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
      threadMetadata = new Map(Object.entries(data));
      console.log(`Loaded ${threadMetadata.size} thread metadata sessions from disk.`);
    }
  } catch (e) {
    console.error('Failed to load thread metadata:', e);
  }
}

function saveMetadata() {
  try {
    const obj = Object.fromEntries(threadMetadata);
    fs.writeFileSync(METADATA_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('Failed to save thread metadata:', e);
  }
}

// Perform initial load
loadMetadata();

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}!`);
  
  // Register slash commands
  console.log('Registering slash commands...');
  const success = await registerCommands(TOKEN, CLIENT_ID, GUILD_ID);
  if (success) {
    console.log('Slash commands registered successfully.');
  } else {
    console.error('Failed to register slash commands.');
  }
  
  console.log('Gateway is ready to receive tasks.');
});

/**
 * Handle command interactions
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'agy' || commandName === 'codex') {
    await handleAgentCommand(interaction);
  } else if (commandName === 'status') {
    await handleStatusCommand(interaction);
  } else if (commandName === 'usage') {
    await handleUsageCommand(interaction);
  } else if (commandName === 'model') {
    await handleModelCommand(interaction);
  } else if (commandName === 'export') {
    await handleExportCommand(interaction);
  } else if (commandName === 'kill') {
    await handleKillCommand(interaction);
  }
});

/**
 * Handle autocomplete interactions for directory suggestions
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isAutocomplete()) return;

  const { commandName } = interaction;

  if (commandName === 'agy' || commandName === 'codex') {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'directory') {
      const root = process.env.PROJECTS_ROOT;
      if (!root) {
        return interaction.respond([]);
      }

      const os = require('os');
      try {
        let resolvedRoot = root;
        if (root.startsWith('~')) {
          resolvedRoot = path.join(os.homedir(), root.substring(1));
        }

        if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
          return interaction.respond([]);
        }

        const subdirs = fs.readdirSync(resolvedRoot);
        const suggestions = [];

        for (const item of subdirs) {
          const fullPath = path.join(resolvedRoot, item);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              const isGit = fs.existsSync(path.join(fullPath, '.git'));
              if (item.toLowerCase().includes(focusedOption.value.toLowerCase())) {
                suggestions.push({
                  name: `${item}${isGit ? ' (git)' : ''}`,
                  value: fullPath
                });
              }
            }
          } catch (e) {}
        }

        await interaction.respond(suggestions.slice(0, 25));
      } catch (err) {
        console.error('Autocomplete error:', err);
        try {
          await interaction.respond([]);
        } catch (e) {}
      }
    }
  }
});

/**
 * Handle button interaction choices
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  if (!customId.startsWith('choice:')) return;

  const value = customId.substring('choice:'.length);
  const threadId = interaction.channelId;

  const task = processManager.activeTasks.get(threadId);
  if (!task) {
    return interaction.reply({
      content: '❌ No active agent task associated with this thread anymore.',
      ephemeral: true
    });
  }

  // Edit original message to disable buttons as immediate visual feedback
  try {
    const disabledRows = interaction.message.components.map(row => {
      const newRow = ActionRowBuilder.from(row.toJSON());
      newRow.components.forEach(btn => {
        btn.setDisabled(true);
        // Highlight the selected option
        if (btn.data.custom_id === customId) {
          btn.setStyle(ButtonStyle.Primary);
        }
      });
      return newRow;
    });
    
    await interaction.update({
      content: `${interaction.message.content}\n\n👉 Selected choice: **${value}**`,
      components: disabledRows
    });
  } catch (err) {
    console.error('Failed to disable buttons:', err);
  }

  // Inject input directly to child process stdin
  const success = await processManager.sendInput(threadId, value);
  if (!success) {
    await interaction.followUp({
      content: '❌ Failed to send input to the active task.',
      ephemeral: true
    });
  }
});

/**
 * Handle message replies inside threads to redirect standard user replies to process stdin
 * or to spawn continuation runs for completed tasks.
 */
client.on('messageCreate', async (message) => {
  // Ignore bots and webhooks
  if (message.author.bot || message.webhookId) return;

  // Verify we are inside a thread
  if (!message.channel.isThread()) return;

  const threadId = message.channel.id;
  const task = processManager.activeTasks.get(threadId);
  const content = message.content.trim();
  if (content.length === 0) return;

  console.log(`[Thread Message] ID: ${threadId}, Author: ${message.author.tag}, Content: "${content}", ActiveTask: ${!!task}`);

  // If there is an active agent task running in this thread
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
    // Check if this thread has historical metadata for conversation resumption
    const meta = threadMetadata.get(threadId);
    if (meta) {
      try {
        await message.react('⚙️');
      } catch (e) {}

      await message.channel.send(`🔄 **Resuming conversation session...**`);

      try {
        await processManager.startTask({
          thread: message.channel,
          tool: meta.tool,
          directory: meta.directory,
          mode: meta.mode,
          prompt: content,
          isContinue: true,
          previousHistoryText: meta.historyText || '',
          model: meta.model,
          flags: meta.flags
        });
      } catch (err) {
        await message.channel.send(`❌ **Failed to resume conversation:** ${err.message}`);
      }
    }
  }
});

/**
 * COMMAND HANDLER: /agent
 */
async function handleAgentCommand(interaction) {
  const tool = interaction.commandName;
  const directory = interaction.options.getString('directory');
  const taskPrompt = interaction.options.getString('task');
  const mode = interaction.options.getString('mode') || 'review';
  const model = interaction.options.getString('model') || null;
  const flags = interaction.options.getString('flags') || null;

  await interaction.deferReply({ ephemeral: true });

  // Basic check on channel support for threads
  const channel = interaction.channel;
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)) {
    return interaction.editReply({
      content: '❌ Agent execution can only be initiated inside a standard Text Channel or a Forum Channel.'
    });
  }

  try {
    // 1. Initiate thread/post
    const name = `[${tool}] ${taskPrompt.substring(0, 75)}`.trim();
    let thread;

    if (channel.type === ChannelType.GuildForum) {
      // Create new Forum Post
      thread = await channel.threads.create({
        name,
        autoArchiveDuration: 1440, // 24 hours of inactivity
        message: {
          content: `### 🤖 Task Initiated
* **Tool:** \`${tool.toUpperCase()}\`
* **Directory:** \`${directory}\`
* **Mode:** \`${mode.toUpperCase()}\`
* **Model:** \`${model || 'Default'}\`
${flags ? `* **Flags:** \`${flags}\`\n` : ''}* **Prompt:** ${taskPrompt}`
        },
        reason: `Agent Gateway Start`
      });
    } else {
      // Create new Thread on standard channel
      thread = await channel.threads.create({
        name,
        autoArchiveDuration: 1440,
        reason: `Agent Gateway Start`
      });

      // Send initial task header card
      await thread.send(`### 🤖 Task Initiated
* **Tool:** \`${tool.toUpperCase()}\`
* **Directory:** \`${directory}\`
* **Mode:** \`${mode.toUpperCase()}\`
* **Model:** \`${model || 'Default'}\`
${flags ? `* **Flags:** \`${flags}\`\n` : ''}* **Prompt:** ${taskPrompt}`);
    }

    // 2. Start background task
    await interaction.editReply({
      content: `✅ Task thread created successfully! Follow progress in: <#${thread.id}>`
    });

    await thread.send('⚙️ Spawning process and initiating local sandbox environment...');

    await processManager.startTask({
      thread,
      tool,
      directory,
      mode,
      prompt: taskPrompt,
      model,
      flags
    });

    // Record thread session metadata for conversation resumption
    threadMetadata.set(thread.id, { tool, directory, mode, model, flags });
    saveMetadata();

  } catch (error) {
    console.error('Error starting agent task:', error);
    await interaction.editReply({
      content: `❌ **Failed to start task:** ${error.message}`
    });
  }
}

/**
 * COMMAND HANDLER: /status
 */
/**
 * COMMAND HANDLER: /status
 */
async function handleStatusCommand(interaction) {
  const threadId = interaction.channelId;
  const task = processManager.activeTasks.get(threadId);
  const meta = threadMetadata.get(threadId);

  if (!task && !meta) {
    return interaction.reply({
      content: '❌ No active agent task or session history found in this thread.',
      ephemeral: true
    });
  }

  await interaction.deferReply();

  let tool = '';
  let status = '';
  let elapsedStr = 'N/A';
  let directory = '';
  let logFile = 'None';
  let mode = '';
  let modelStr = 'Default';
  
  let quotaInfo = 'Not reported by tool';
  let tokenInfo = 'Not reported by tool';
  let subagentInfo = 'None reported';

  if (task) {
    // Task is currently executing
    tool = task.tool.toUpperCase();
    status = `RUNNING (${task.status})`;
    elapsedStr = processManager.formatDuration(Date.now() - task.startTime);
    directory = task.directory;
    logFile = task.fullLogFile;
    mode = task.mode.toUpperCase();
    modelStr = task.model || 'Default';

    try {
      if (fs.existsSync(task.fullLogFile)) {
        const logs = fs.readFileSync(task.fullLogFile, 'utf8');
        
        // Parse quota/cost references
        const quotaMatch = logs.match(/cost|quota|price|charge.*\$([\d\.]+)/i) || logs.match(/([\$0-9\.]+)\s*(?:credits|dollars)/i);
        if (quotaMatch) {
          quotaInfo = quotaMatch[0];
        }
        
        // Parse tokens
        const tokenMatch = logs.match(/tokens used\s*\n\s*([\d,]+)/i) || logs.match(/(\d+)\s*(?:total\s*)?tokens/i) || logs.match(/tokens?:\s*(\d+)/i);
        if (tokenMatch) {
          tokenInfo = `${parseInt(tokenMatch[1].replace(/,/g, ''), 10).toLocaleString()} tokens`;
        }

        // Parse subagents
        const subagentMatch = logs.match(/(?:spawned|active)\s*(?:subagent|agent)\s*["']?([a-zA-Z0-9_-]+)["']?/i) || logs.match(/subagent\s+(\w+)/i);
        if (subagentMatch) {
          subagentInfo = subagentMatch[0];
        }
      }
    } catch (e) {
      console.error('Error reading log for metrics:', e);
    }
  } else {
    // Task has completed, show last session details
    tool = meta.tool.toUpperCase();
    status = 'IDLE (Completed)';
    directory = meta.directory;
    mode = meta.mode.toUpperCase();
    modelStr = meta.model || 'Default';

    // Scan for the latest session log in the workspace
    try {
      const os = require('os');
      let resolvedDir = directory;
      if (directory.startsWith('~')) {
        resolvedDir = path.join(os.homedir(), directory.substring(1));
      }

      if (fs.existsSync(resolvedDir) && fs.statSync(resolvedDir).isDirectory()) {
        const files = fs.readdirSync(resolvedDir)
          .filter(f => f.startsWith(`.gateway-${meta.tool}-`) && f.endsWith('.log'));

        if (files.length > 0) {
          files.sort((a, b) => b.localeCompare(a)); // Sort latest first
          logFile = path.join(resolvedDir, files[0]);

          if (fs.existsSync(logFile)) {
            const logs = fs.readFileSync(logFile, 'utf8');

            const quotaMatch = logs.match(/cost|quota|price|charge.*\$([\d\.]+)/i) || logs.match(/([\$0-9\.]+)\s*(?:credits|dollars)/i);
            if (quotaMatch) quotaInfo = quotaMatch[0];

            const tokenMatch = logs.match(/tokens used\s*\n\s*([\d,]+)/i) || logs.match(/(\d+)\s*(?:total\s*)?tokens/i) || logs.match(/tokens?:\s*(\d+)/i);
            if (tokenMatch) {
              tokenInfo = `${parseInt(tokenMatch[1].replace(/,/g, ''), 10).toLocaleString()} tokens`;
            }

            const subagentMatch = logs.match(/(?:spawned|active)\s*(?:subagent|agent)\s*["']?([a-zA-Z0-9_-]+)["']?/i) || logs.match(/subagent\s+(\w+)/i);
            if (subagentMatch) subagentInfo = subagentMatch[0];
          }
        }
      }
    } catch (e) {
      console.error('Error scanning completed logs for status:', e);
    }
  }

  const statusCard = `### 📊 Task Status Info
* **Tool:** \`${tool}\`
* **Status:** \`${status}\`
* **Model Configured:** \`${modelStr}\`
* **Last Elapsed Execution Time:** \`${elapsedStr}\`
* **Working Directory:** \`${directory}\`
* **Last Log File:** \`${logFile}\`
* **Model/Token Quota Use:** \`${tokenInfo}\`
* **Cost Metrics:** \`${quotaInfo}\`
* **Background Subagents:** \`${subagentInfo}\`
* **Execution Mode:** \`${mode}\``;

  await interaction.editReply(statusCard);
}

/**
 * COMMAND HANDLER: /export
 */
async function handleExportCommand(interaction) {
  const threadId = interaction.channelId;
  const task = processManager.activeTasks.get(threadId);

  if (!task) {
    return interaction.reply({
      content: '❌ No active agent task found in this thread.',
      ephemeral: true
    });
  }

  await interaction.deferReply();

  const exportPath = await processManager.exportTask(threadId);
  if (exportPath) {
    await interaction.editReply(`✅ **Session context exported successfully!**\n* **Path:** \`${exportPath}\``);
  } else {
    await interaction.editReply('❌ **Failed to export session context.** Check bot console logs.');
  }
}

/**
 * COMMAND HANDLER: /kill
 */
async function handleKillCommand(interaction) {
  const threadId = interaction.channelId;
  const task = processManager.activeTasks.get(threadId);

  if (!task) {
    return interaction.reply({
      content: '❌ No active agent task found in this thread.',
      ephemeral: true
    });
  }

  await interaction.reply('🛑 **Forcefully terminating active shell process...**');
  const success = await processManager.killTask(threadId);
  if (!success) {
    await interaction.followUp({
      content: '❌ Failed to terminate process.',
      ephemeral: true
    });
  }
}

/**
 * COMMAND HANDLER: /model
 */
async function handleModelCommand(interaction) {
  const threadId = interaction.channelId;
  const newModelName = interaction.options.getString('name');
  
  const meta = threadMetadata.get(threadId);
  const task = processManager.activeTasks.get(threadId);

  if (!meta) {
    return interaction.reply({
      content: '❌ This channel is not a registered agent task thread.',
      ephemeral: true
    });
  }

  if (newModelName) {
    // Setting a new model
    const oldModel = meta.model || 'Default';
    meta.model = newModelName;
    saveMetadata();

    let response = `✅ **Model updated successfully!**\n* **Thread Model:** \`${oldModel}\` ➔ \`${newModelName}\`\nThis model will be used for subsequent continuation runs.`;
    
    if (task) {
      response += `\n\n⚠️ *Note: An active process is currently running on model \`${task.model || 'Default'}\`. The new model will take effect once the current task finishes and a new one is resumed.*`;
    }

    return interaction.reply(response);
  } else {
    // Querying the current model
    const currentModel = meta.model || 'Default';
    let response = `🤖 **Current thread model configuration:** \`${currentModel}\``;
    
    if (task) {
      response += `\n* **Active running process model:** \`${task.model || 'Default'}\``;
    }
    
    return interaction.reply(response);
  }
}

// Log registry file for overall token usage statistics
const USAGE_FILE = path.join(__dirname, '../.usage-registry.json');

function recordUsage(tool, tokens) {
  if (!tokens || isNaN(tokens)) return;
  try {
    let data = [];
    if (fs.existsSync(USAGE_FILE)) {
      data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    }
    data.push({
      timestamp: new Date().toISOString(),
      tool,
      tokens
    });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to record usage:', e);
  }
}

// COMMAND HANDLER: /usage
async function handleUsageCommand(interaction) {
  await interaction.deferReply();

  const limit = parseInt(process.env.MONTHLY_QUOTA_LIMIT, 10) || 5000000;
  const resetDay = parseInt(process.env.QUOTA_RESET_DAY, 10) || 1;

  let totalTokens = 0;
  let agyTokens = 0;
  let codexTokens = 0;

  // Calculate billing cycle range
  const now = new Date();
  const startOfCycle = new Date(now.getFullYear(), now.getMonth(), resetDay);
  if (now < startOfCycle) {
    startOfCycle.setMonth(startOfCycle.getMonth() - 1);
  }
  
  const nextReset = new Date(startOfCycle);
  nextReset.setMonth(nextReset.getMonth() + 1);

  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      data.forEach(record => {
        const time = new Date(record.timestamp);
        if (time >= startOfCycle && time < nextReset) {
          totalTokens += record.tokens;
          if (record.tool === 'agy') agyTokens += record.tokens;
          if (record.tool === 'codex') codexTokens += record.tokens;
        }
      });
    }
  } catch (e) {
    console.error('Failed to read usage registry:', e);
  }

  const remaining = Math.max(0, limit - totalTokens);
  const usagePct = ((totalTokens / limit) * 100).toFixed(1);
  const remainingPct = (100 - parseFloat(usagePct)).toFixed(1);

  const usageCard = `### 💳 Token Usage & Quota Info
* **Billing Cycle:** \`${startOfCycle.toLocaleDateString()}\` to \`${nextReset.toLocaleDateString()}\`
* **Next Reset Date:** \`${nextReset.toLocaleDateString()}\`
* **Quota Limit:** \`${limit.toLocaleString()} tokens\`
* **Total Used:** \`${totalTokens.toLocaleString()} tokens\` (\`${usagePct}%\`)
  * *Antigravity CLI (agy):* \`${agyTokens.toLocaleString()} tokens\`
  * *Codex CLI (codex):* \`${codexTokens.toLocaleString()} tokens\`
* **Quota Remaining:** \`${remaining.toLocaleString()} tokens\` (\`${remainingPct}%\`)`;

  await interaction.editReply(usageCard);
}

// Listen to processManager task ending to record the final conversation turn history
processManager.on('taskEnded', (task) => {
  const meta = threadMetadata.get(task.threadId);
  if (meta) {
    const { stripDuplicatePrefix } = require('./parser');
    const finalNewContent = stripDuplicatePrefix(task.previousHistoryText, task.processStdoutAccumulator);
    
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
        recordUsage(task.tool, tokens);
        console.log(`[Task Ended] Recorded usage: ${tokens} tokens for ${task.tool}.`);
      }
    }
  }
});

// Bot token authorization login
client.login(TOKEN);
