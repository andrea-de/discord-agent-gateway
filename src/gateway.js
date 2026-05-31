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
        
        // 1. Find or create the Category
        let category = guild.channels.cache.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
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
        let gatewayChannel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);
        if (!gatewayChannel) {
          try {
            const channelOpts = {
              name: channelName,
              type: ChannelType.GuildText,
              reason: `Gateway startup auto-provision`
            };
            if (category) {
              channelOpts.parent = category.id;
            }
            gatewayChannel = await guild.channels.create(channelOpts);
            console.log(`Created gateway channel "#${channelName}" on startup.`);
          } catch (chanErr) {
            console.warn(`Could not create gateway channel "#${channelName}" on startup:`, chanErr.message);
          }
        }
        
        // 3. Post online message
        if (gatewayChannel) {
          await gatewayChannel.send(`🟢 **Agent Gateway [${currentGateway}] is online and ready to receive tasks.**\nAll commands run inside this category or channel will automatically target this instance.`);
          console.log(`Sent startup online message to #${channelName}.`);
        }
      }
    } catch (err) {
      console.warn('Startup category/channel auto-provisioning failed:', err.message);
    }
  }
  
  console.log('Gateway is ready to receive tasks.');
});

/**
 * Handle command interactions
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!isTargetForInteraction(interaction)) {
    return; // Ignore if this instance is not the target
  }

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

  if (!isTargetForInteraction(interaction)) {
    return; // Ignore autocomplete suggestions for other instances
  }

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

  // Verify target gateway for this thread to prevent multiple bot instances from responding
  const { gateway } = resolveGatewayAndProject(message.channel);
  if (gateway && gateway !== currentGateway) {
    return; // Ignore if this thread belongs to a different gateway
  }

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

const currentGateway = (process.env.GATEWAY_NAME || 'HELSINKI').toUpperCase();

function resolveGatewayAndProject(channel) {
  let textChannel = channel;
  if (channel.isThread()) {
    textChannel = channel.parent;
  }
  
  if (!textChannel) return { gateway: null, project: null };
  
  const parentCategory = textChannel.parent;
  let gateway = null;
  let project = null;
  
  if (parentCategory && parentCategory.name.endsWith(' GATEWAY')) {
    gateway = parentCategory.name.replace(' GATEWAY', '').trim().toUpperCase();
    project = textChannel.name;
  } else {
    // If the text channel is a general channel for a specific gateway (e.g. #helsinki)
    const channelNameClean = textChannel.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const knownGateways = ['HELSINKI', 'NUREMBERG']; // Standard gateways
    if (knownGateways.includes(channelNameClean)) {
      gateway = channelNameClean;
    }
  }
  
  return { gateway, project };
}

function isTargetForInteraction(interaction) {
  const channel = interaction.channel;
  if (!channel) return false;
  
  let textChannel = channel;
  if (channel.isThread()) {
    textChannel = channel.parent;
  }
  if (!textChannel) return false;

  // 1. Check parent category name (e.g. "HELSINKI GATEWAY")
  const parentCategory = textChannel.parent;
  if (parentCategory && parentCategory.name.endsWith(' GATEWAY')) {
    const channelGateway = parentCategory.name.replace(' GATEWAY', '').trim().toUpperCase();
    return channelGateway === currentGateway;
  }

  // 2. Check text channel name (e.g. #helsinki -> matches HELSINKI)
  const channelNameClean = textChannel.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (channelNameClean === currentGateway) {
    return true;
  }
  
  // If the channel name is matching *another* known gateway, we are NOT the target
  const knownGateways = ['HELSINKI', 'NUREMBERG'];
  if (knownGateways.includes(channelNameClean) && channelNameClean !== currentGateway) {
    return false;
  }

  // 3. Check explicitly chosen option "gateway"
  try {
    const chosenGateway = interaction.options.getString('gateway');
    if (chosenGateway) {
      return chosenGateway.toUpperCase() === currentGateway;
    }
  } catch (e) {}

  // 4. Default: If run in general and no option is specified, let HELSINKI act as default responder to explain
  if (!chosenGateway && !channelGateway) {
    return currentGateway === 'HELSINKI';
  }

  return false;
}

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

  const guild = interaction.guild;
  if (!guild) {
    return interaction.editReply({
      content: '❌ This command can only be executed within a Discord Server (Guild).'
    });
  }

  // Basic check on channel support for threads
  const channel = interaction.channel;
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)) {
    return interaction.editReply({
      content: '❌ Agent execution can only be initiated inside a standard Text Channel or a Forum Channel.'
    });
  }

  // Target Gateway resolution & validation
  const chosenGateway = interaction.options.getString('gateway');
  const { gateway: inferredGateway, project: inferredProject } = resolveGatewayAndProject(channel);

  if (!inferredGateway && !chosenGateway) {
    return interaction.editReply({
      content: `❌ **Target Gateway required:** Please specify the \`gateway\` option when running from a general channel.`
    });
  }

  // Resolve directory path
  const PROJECTS_ROOT = process.env.PROJECTS_ROOT;
  let resolvedDirectory = directory;

  if (!resolvedDirectory && inferredProject) {
    if (PROJECTS_ROOT) {
      const os = require('os');
      let resolvedRoot = PROJECTS_ROOT;
      if (PROJECTS_ROOT.startsWith('~')) {
        resolvedRoot = path.join(os.homedir(), PROJECTS_ROOT.substring(1));
      }
      const targetPath = path.join(resolvedRoot, inferredProject);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        resolvedDirectory = targetPath;
      }
    }
  }

  // Resolve relative directory names if typed manually
  if (resolvedDirectory && !path.isAbsolute(resolvedDirectory) && !resolvedDirectory.startsWith('~')) {
    if (PROJECTS_ROOT) {
      const os = require('os');
      let resolvedRoot = PROJECTS_ROOT;
      if (PROJECTS_ROOT.startsWith('~')) {
        resolvedRoot = path.join(os.homedir(), PROJECTS_ROOT.substring(1));
      }
      const targetPath = path.join(resolvedRoot, resolvedDirectory);
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
        resolvedDirectory = targetPath;
      }
    }
  }

  if (!resolvedDirectory) {
    return interaction.editReply({
      content: `❌ **Directory required:** Please specify the \`directory\` option or run the command from a project-specific text channel under a Gateway Category.`
    });
  }

  // Derive project channel name from the resolved directory path
  const projectDirName = resolvedDirectory.split(/[/\\]/).filter(Boolean).pop() || 'general';
  const channelName = projectDirName.toLowerCase().replace(/[^a-z0-9_-]/g, '');

  let targetChannel = channel;
  let permissionWarning = null;
  const categoryName = `${currentGateway} GATEWAY`;

  try {
    // 1. Find or create the Gateway category (e.g. HELSINKI GATEWAY)
    let category = guild.channels.cache.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
    if (!category) {
      try {
        category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory
        });
      } catch (catErr) {
        console.warn(`Could not create category "${categoryName}":`, catErr.message);
        if (catErr.code === 50013 || catErr.status === 403) {
          permissionWarning = `Missing "Manage Channels" permission to create the "${categoryName}" category.`;
        }
      }
    }

    // 2. Find or create the project-specific text channel under that category
    let projectChannel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);
    if (!projectChannel) {
      const channelOpts = {
        name: channelName,
        type: ChannelType.GuildText,
        reason: `Auto-provisioned text channel for directory: ${resolvedDirectory}`
      };
      if (category) {
        channelOpts.parent = category.id;
      }
      projectChannel = await guild.channels.create(channelOpts);
      await projectChannel.send(`📁 **Welcome to the Project Channel for \`${projectDirName}\`!**\nAll agent tasks run inside this directory will be spawned as threads here.`);
    }
    targetChannel = projectChannel;
  } catch (chanErr) {
    console.error('Failed to resolve project channel, falling back to current channel:', chanErr);
    if (chanErr.code === 50013 || chanErr.status === 403) {
      permissionWarning = 'Missing "Manage Channels" permission to create project text channels.';
    }
    targetChannel = channel;
  }

  try {
    // 1. Initiate thread
    const name = `[${tool}] ${taskPrompt.substring(0, 75)}`.trim();
    let thread;

    // Create new Thread on the resolved project channel
    thread = await targetChannel.threads.create({
      name,
      autoArchiveDuration: 1440,
      reason: `Agent Gateway Start`
    });

    // Send initial task header card
    await thread.send(`### 🤖 Task Initiated
* **Tool:** \`${tool.toUpperCase()}\`
* **Directory:** \`${resolvedDirectory}\`
* **Mode:** \`${mode.toUpperCase()}\`
* **Model:** \`${model || 'Default'}\`
${flags ? `* **Flags:** \`${flags}\`\n` : ''}* **Prompt:** ${taskPrompt}`);

    if (permissionWarning) {
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=105226685456&scope=bot%20applications.commands`;
      await thread.send(`⚠️ **Notice:** ${permissionWarning} Thread fell back to the current channel (<#${channel.id}>). To enable auto-channel creation for new projects under an **${categoryName}** category, please grant the bot the **Manage Channels** permission, or [click here to re-authorize the bot](${inviteUrl}).`);
    }

    // 2. Start background task
    await interaction.editReply({
      content: `✅ Task thread created successfully in <#${targetChannel.id}>! Follow progress in: <#${thread.id}>`
    });

    await thread.send('⚙️ Spawning process and initiating local sandbox environment...');

    await processManager.startTask({
      thread,
      tool,
      directory: resolvedDirectory,
      mode,
      prompt: taskPrompt,
      model,
      flags
    });

    // Record thread session metadata for conversation resumption
    threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode, model, flags });
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

function recordUsage(tool, threadId, model, tokens) {
  if (!tokens || isNaN(tokens)) return;
  try {
    let data = [];
    if (fs.existsSync(USAGE_FILE)) {
      data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    }
    data.push({
      timestamp: new Date().toISOString(),
      threadId,
      tool,
      model: model || 'Default',
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

  const threadId = interaction.channelId;
  const meta = threadMetadata.get(threadId);

  let threadTokens = 0;
  let globalTokens = 0;
  let toolTotals = { agy: 0, codex: 0 };
  let threadTotalsMap = new Map(); // threadId -> { tool, tokens }
  let threadModelTotals = new Map(); // modelName -> tokens

  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      data.forEach(record => {
        globalTokens += record.tokens;
        if (record.tool === 'agy') toolTotals.agy += record.tokens;
        if (record.tool === 'codex') toolTotals.codex += record.tokens;

        if (record.threadId) {
          if (record.threadId === threadId) {
            threadTokens += record.tokens;
            const modelKey = record.model || (record.tool === 'agy' ? 'Gemini 3.5 Flash' : 'Default Codex Model');
            const prevModelTokens = threadModelTotals.get(modelKey) || 0;
            threadModelTotals.set(modelKey, prevModelTokens + record.tokens);
          }
          const current = threadTotalsMap.get(record.threadId) || { tool: record.tool, tokens: 0 };
          current.tokens += record.tokens;
          threadTotalsMap.set(record.threadId, current);
        }
      });
    }
  } catch (e) {
    console.error('Failed to read usage registry:', e);
  }

  if (meta) {
    // Inside an active agent task thread: show provider specific info
    const { getDriver } = require('./drivers');
    try {
      const driver = getDriver(meta.tool);
      const usageCard = driver.getProviderUsageInfo(threadTokens, meta.model, threadModelTotals);
      return interaction.editReply(usageCard);
    } catch (err) {
      return interaction.editReply(`❌ **Failed to retrieve provider usage details:** ${err.message}`);
    }
  } else {
    // Outside a thread: show a general overview of all active project threads and global totals
    let overviewText = `### 📊 Global Token Usage Overview\n`;
    overviewText += `* **Total Tokens Consumed:** \`${globalTokens.toLocaleString()} tokens\`\n`;
    overviewText += `  * *Antigravity CLI (agy):* \`${toolTotals.agy.toLocaleString()} tokens\`\n`;
    overviewText += `  * *Codex CLI (codex):* \`${toolTotals.codex.toLocaleString()} tokens\`\n\n`;

    overviewText += `**Active Sessions Usage Breakdown:**\n`;
    if (threadTotalsMap.size === 0) {
      overviewText += `* *No logged session usage found in registry.*`;
    } else {
      for (const [id, stats] of threadTotalsMap.entries()) {
        const threadMeta = threadMetadata.get(id);
        const name = threadMeta ? `[${stats.tool.toUpperCase()}] ${threadMeta.directory.split('/').pop()}` : `Thread #${id}`;
        overviewText += `* **Channel <#${id}> (${name}):** \`${stats.tokens.toLocaleString()} tokens\`\n`;
      }
    }
    overviewText += `\n*Tip: Run \`/usage\` inside a specific project thread to view detailed model quotas and rate limits.*`;

    return interaction.editReply(overviewText);
  }
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
        recordUsage(task.tool, task.threadId, meta.model, tokens);
        console.log(`[Task Ended] Recorded usage: ${tokens} tokens for ${task.tool} (${meta.model}) in thread ${task.threadId}.`);
      }
    }
  }
});

// Bot token authorization login
client.login(TOKEN);
