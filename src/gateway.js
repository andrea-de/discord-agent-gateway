require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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

// Robustness: Handle client and process-level errors to prevent crashes
client.on('error', (err) => {
  console.error('[Discord Client Error]', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
  // Optional: check if we should exit or try to recover
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
          await gatewayChannel.send(`🟢 **Agent Gateway [${currentGateway}] is online and ready to receive tasks.**\nAll commands run inside this category or channel will automatically target this instance.`);
          console.log(`Sent startup online message to #${channelName}.`);
          
          // Initialize Global Dashboard
          await initDashboard(gatewayChannel);
        }
      }
    } catch (err) {
      console.warn('Startup category/channel auto-provisioning failed:', err.message);
    }
  }
  
  console.log('Gateway is ready to receive tasks.');
  performSandboxDiagnostics();
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

  if (commandName === 'antigravity' || commandName === 'codex' || commandName === 'gemini') {
    await handleAgentCommand(interaction);
  } else if (commandName === 'status') {
    await handleStatusCommand(interaction);
  } else if (commandName === 'usage') {
    await handleUsageCommand(interaction);
  } else if (commandName === 'sessions') {
    await handleSessionsCommand(interaction);
  } else if (commandName === 'model') {
    await handleModelCommand(interaction);
  } else if (commandName === 'permission') {
    await handlePermissionCommand(interaction);
  } else if (commandName === 'export') {
    await handleExportCommand(interaction);
  } else if (commandName === 'rename') {
    await handleRenameCommand(interaction);
  } else if (commandName === 'delete') {
    await handleDeleteCommand(interaction);
  } else if (commandName === 'kill') {
    await handleKillCommand(interaction);
  } else if (commandName === 'info') {
    await handleInfoCommand(interaction);
  } else if (commandName === 'restart') {
    await handleRestartCommand(interaction);
  }
});

/**
 * Handle modal submissions
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  if (interaction.customId === 'session-modal') {
    await handleSessionModal(interaction);
  }
});

async function handleSessionModal(interaction) {
  const toolRaw = interaction.fields.getTextInputValue('tool').toLowerCase().trim();
  const tool = toolRaw === 'antigravity' ? 'agy' : toolRaw;
  const prompt = interaction.fields.getTextInputValue('prompt').trim();
  
  const { gateway, project: inferredProject } = resolveGatewayAndProject(interaction.channel);
  
  // Resolve directory (same logic as handleAgentCommand but simplified for the project channel context)
  const PROJECTS_ROOT = process.env.PROJECTS_ROOT;
  let resolvedDirectory = null;

  if (PROJECTS_ROOT && inferredProject) {
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

  if (!resolvedDirectory) {
    return interaction.reply({ content: '❌ Could not resolve directory for this project.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const threadName = prompt ? `[${tool}] ${prompt.substring(0, 75)}` : `[${tool}] Interactive Session`;
    const thread = await interaction.channel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      reason: 'Agent Gateway Modal Start'
    });

    await thread.send(`### 🤖 Session Initiated via Dashboard
* **Tool:** \`${tool.toUpperCase()}\`
* **Directory:** \`${resolvedDirectory}\`
* **Prompt:** ${prompt || '*Awaiting first prompt in thread...*'}`);

    if (prompt) {
      await thread.send('⚙️ Spawning process...');
      await processManager.startTask({
        thread,
        tool,
        directory: resolvedDirectory,
        mode: 'review',
        prompt: prompt
      });
      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode: 'review', hasStarted: true });
    } else {
      await thread.send('⌨️ **Gateway Awaiting First Prompt**');
      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode: 'review', hasStarted: false });
    }
    saveMetadata();

    await interaction.editReply({ content: `✅ Session started in <#${thread.id}>` });
  } catch (err) {
    console.error('Modal task start failed:', err);
    await interaction.editReply({ content: `❌ Failed to start session: ${err.message}` });
  }
}

/**
 * Handle autocomplete interactions for directory suggestions
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isAutocomplete()) return;

  if (!isTargetForInteraction(interaction)) {
    return; // Ignore autocomplete suggestions for other instances
  }

  const { commandName } = interaction;

  if (commandName === 'antigravity' || commandName === 'codex' || commandName === 'gemini') {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === 'directory') {
      const channel = interaction.channel;
      if (channel) {
        const parentCategory = channel.parent;
        const isProjectChannel = parentCategory && parentCategory.name === `${currentGateway} GATEWAY` && channel.type === ChannelType.GuildText;
        if (isProjectChannel) {
          return interaction.respond([]);
        }
      }

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
  if (customId.startsWith('choice:')) {
    await handleChoiceButton(interaction);
  } else if (customId.startsWith('project:')) {
    await handleProjectButton(interaction);
  } else if (customId.startsWith('thread:')) {
    await handleThreadButton(interaction);
  } else if (customId.startsWith('dashboard:')) {
    await handleDashboardButton(interaction);
  } else if (customId.startsWith('session:')) {
    await handleSessionButton(interaction);
  }
});

async function handleChoiceButton(interaction) {
  const customId = interaction.customId;
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
 * Handle button clicks for thread-specific management (delete, confirm-delete)
 */
async function handleThreadButton(interaction) {
  const action = interaction.customId.substring('thread:'.length);
  const channel = interaction.channel;

  if (action === 'confirm-delete') {
    if (!channel || !channel.isThread()) return;
    
    const threadId = channel.id;
    
    // 1. Notify
    await interaction.update({ content: '🗑️ **Deleting thread and cleaning up metadata...**', components: [] });

    // 2. Kill active task if any
    const task = processManager.activeTasks.get(threadId);
    if (task) {
      await processManager.killTask(threadId);
    }

    // 3. Cleanup Metadata
    if (threadMetadata.has(threadId)) {
      threadMetadata.delete(threadId);
      saveMetadata();
    }

    // 4. Delete Thread
    try {
      await channel.delete();
    } catch (err) {
      console.error('Failed to delete thread:', err);
    }

  } else if (action === 'cancel-delete') {
    await interaction.update({ content: '✅ **Deletion cancelled.**', components: [] });
  }
}

/**
 * Handle button interaction for project dashboards
 */
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  if (!customId.startsWith('project:')) return;

  await handleProjectButton(interaction);
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
    const suffix = `-${gateway.toLowerCase()}`;
    if (textChannel.name.endsWith(suffix)) {
      project = textChannel.name.substring(0, textChannel.name.length - suffix.length);
    } else {
      project = textChannel.name;
    }
  } else {
    // If the text channel is a general channel for a specific gateway (e.g. #helsinki)
    const channelNameClean = textChannel.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const knownGateways = ['HELSINKI', 'NUREMBERG', 'XPS']; // Standard gateways
    if (knownGateways.includes(channelNameClean)) {
      gateway = channelNameClean;
    }
  }
  
  return { gateway, project };
}

function isTargetForInteraction(interaction) {
  // 1. Check explicitly chosen option "gateway" first
  let chosenGateway = null;
  try {
    chosenGateway = interaction.options.getString('gateway');
    if (chosenGateway) {
      return chosenGateway.toUpperCase() === currentGateway;
    }
  } catch (e) {}

  const channel = interaction.channel;
  if (!channel) return false;
  
  let textChannel = channel;
  if (channel.isThread()) {
    textChannel = channel.parent;
  }
  if (!textChannel) return false;

  let channelGateway = null;
  // 2. Check parent category name (e.g. "HELSINKI GATEWAY")
  const parentCategory = textChannel.parent;
  if (parentCategory && parentCategory.name.endsWith(' GATEWAY')) {
    channelGateway = parentCategory.name.replace(' GATEWAY', '').trim().toUpperCase();
    if (channelGateway === currentGateway) {
      return true;
    }
  }

  // 3. Check text channel name (e.g. #helsinki -> matches HELSINKI)
  const channelNameClean = textChannel.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (channelNameClean === currentGateway) {
    return true;
  }
  
  // If the channel name is matching *another* known gateway, we are NOT the target
  const knownGateways = ['HELSINKI', 'NUREMBERG', 'XPS'];
  if (knownGateways.includes(channelNameClean) && channelNameClean !== currentGateway) {
    return false;
  }

  // 4. Default: If run in general and no option is specified, let XPS act as default responder to explain
  if (!chosenGateway && !channelGateway) {
    return currentGateway === 'XPS';
  }

  return false;
}

/**
 * COMMAND HANDLER: /agent
 */
async function handleAgentCommand(interaction) {
  let tool = interaction.commandName;
  if (tool === 'antigravity') {
    tool = 'agy';
  }
  const directory = interaction.options.getString('directory');
  const taskPrompt = interaction.options.getString('task');
  const mode = interaction.options.getString('mode') || 'review';
  const model = interaction.options.getString('model') || null;
  const flags = interaction.options.getString('flags') || null;
  const sandbox = tool === 'agy'
    ? (interaction.options.getBoolean('sandbox') ?? null)
    : (interaction.options.getString('sandbox') ?? null);

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.warn(`Failed to defer reply for ${tool} command:`, err.message);
    return;
  }

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

  // 1. If inside the root status/gateway channel (e.g. #xps)
  if (channel.name.toLowerCase() === currentGateway.toLowerCase() && !channel.parentId) {
    if (chosenGateway && chosenGateway.toUpperCase() !== currentGateway) {
      return interaction.editReply({
        content: `❌ **Invalid Gateway:** Inside the status channel <#${channel.id}>, the gateway is locked to **${currentGateway}**. You cannot target a different gateway here.`
      });
    }
  }

  // 2. If inside a project channel under current category (e.g. category name ends with " GATEWAY")
  const parentCategory = channel.parent;
  const isProjectChannel = parentCategory && parentCategory.name === `${currentGateway} GATEWAY` && channel.type === ChannelType.GuildText;

  if (isProjectChannel) {
    if (chosenGateway && chosenGateway.toUpperCase() !== currentGateway) {
      return interaction.editReply({
        content: `❌ **Invalid Option:** Inside project-specific channels, the gateway is locked to **${currentGateway}**. Please omit the \`gateway\` option.`
      });
    }
    if (directory) {
      return interaction.editReply({
        content: `❌ **Invalid Option:** Inside project-specific channels, the directory is locked to this project. Please omit the \`directory\` option.`
      });
    }
  }

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
      resolvedDirectory = path.join(resolvedRoot, inferredProject);
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
      resolvedDirectory = path.join(resolvedRoot, resolvedDirectory);
    }
  }

  if (!resolvedDirectory) {
    return interaction.editReply({
      content: `❌ **Directory required:** Please specify the \`directory\` option or run the command from a project-specific text channel under a Gateway Category.`
    });
  }

  // Derive project channel name from the resolved directory path
  const projectDirName = resolvedDirectory.split(/[/\\]/).filter(Boolean).pop() || 'general';
  const baseChannelName = projectDirName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const channelName = `${baseChannelName}-${currentGateway.toLowerCase()}`;

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

      const embed = new EmbedBuilder()
        .setTitle(`📁 Project Dashboard: ${projectDirName}`)
        .setDescription(`Welcome to the Project Channel for **${projectDirName}**!\nAll agent tasks run inside this directory will be spawned as threads here.\n\nUse the buttons below to interactively query project info ephemerally.`)
        .setColor('#2b2d31')
        .addFields(
          { name: 'Gateway', value: `\`${currentGateway}\``, inline: true },
          { name: 'Directory', value: `\`${resolvedDirectory}\``, inline: true }
        );

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('project:new-session')
          .setLabel('New Session')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🚀'),
        new ButtonBuilder()
          .setCustomId('project:history')
          .setLabel('History')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📂'),
        new ButtonBuilder()
          .setCustomId('project:readme')
          .setLabel('README')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📖'),
        new ButtonBuilder()
          .setCustomId('project:files')
          .setLabel('Files')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📁'),
        new ButtonBuilder()
          .setCustomId('project:git')
          .setLabel('Git')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🌿')
      );

      await projectChannel.send({ embeds: [embed], components: [row] });
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
    const hasPrompt = !!(taskPrompt && taskPrompt.trim());
    const name = hasPrompt
      ? `[${tool}] ${taskPrompt.trim().substring(0, 75)}`.trim()
      : `[${tool}] Interactive Session`;
    let thread;

    // Create new Thread on the resolved project channel
    thread = await targetChannel.threads.create({
      name,
      autoArchiveDuration: 1440,
      reason: `Agent Gateway Start`
    });

    // Send initial task header card
    const promptDisplay = hasPrompt ? taskPrompt : '*Awaiting first prompt in thread...*';
    const sandboxDisplay = tool === 'codex'
      ? (sandbox || (mode === 'yolo' ? 'danger-full-access' : 'workspace-write'))
      : (sandbox !== undefined && sandbox !== null ? sandbox : 'Default');
    const displayTool = tool === 'agy' ? 'antigravity' : tool;
    await thread.send(`### 🤖 ${hasPrompt ? 'Task' : 'Interactive Session'} Initiated
* **Tool:** \`${displayTool.toUpperCase()}\`
* **Directory:** \`${resolvedDirectory}\`
* **Mode:** \`${mode.toUpperCase()}\`
* **Model:** \`${model || 'Default'}\`
* **Sandbox Policy:** \`${sandboxDisplay}\`
${flags ? `* **Flags:** \`${flags}\`\n` : ''}* **Prompt:** ${promptDisplay}`);

    if (permissionWarning) {
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=105226685456&scope=bot%20applications.commands`;
      await thread.send(`⚠️ **Notice:** ${permissionWarning} Thread fell back to the current channel (<#${channel.id}>). To enable auto-channel creation for new projects under an **${categoryName}** category, please grant the bot the **Manage Channels** permission, or [click here to re-authorize the bot](${inviteUrl}).`);
    }

    if (hasPrompt) {
      // 2. Start background task immediately
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
        flags,
        sandbox
      });

      // Record thread session metadata for conversation resumption
      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode, model, flags, sandbox, hasStarted: true });
      saveMetadata();
    } else {
      // 2. Await prompt from thread
      await interaction.editReply({
        content: `✅ Interactive session thread created successfully in <#${targetChannel.id}>! Follow progress in: <#${thread.id}>`
      });

      await thread.send('⌨️ **Gateway Awaiting First Prompt**\nPlease type your first task or question directly in this thread to initiate the agent process.');

      // Record thread session metadata as not started
      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode, model, flags, sandbox, hasStarted: false });
      saveMetadata();
    }

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

  try {
    await interaction.deferReply();
  } catch (err) {
    console.warn('Failed to defer reply for status command:', err.message);
    return;
  }

  let tool = '';
  let status = '';
  let elapsedStr = 'N/A';
  let directory = '';
  let logFile = 'None';
  let mode = '';
  let modelStr = 'Default';
  let sandboxVal = 'Default';
  
  let quotaInfo = 'Not reported by tool';
  let tokenInfo = 'Not reported by tool';
  let subagentInfo = 'None reported';

  if (task) {
    // Task is currently executing
    tool = (task.tool === 'agy' ? 'antigravity' : task.tool).toUpperCase();
    status = `RUNNING (${task.status})`;
    elapsedStr = processManager.formatDuration(Date.now() - task.startTime);
    directory = task.directory;
    logFile = task.fullLogFile;
    mode = task.mode.toUpperCase();
    modelStr = task.model || 'Default';
    sandboxVal = task.sandbox !== undefined && task.sandbox !== null ? String(task.sandbox) : 'Default';

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
    tool = (meta.tool === 'agy' ? 'antigravity' : meta.tool).toUpperCase();
    status = meta.hasStarted === false ? 'AWAITING FIRST PROMPT' : 'IDLE (Completed)';
    directory = meta.directory;
    mode = meta.mode.toUpperCase();
    modelStr = meta.model || 'Default';
    sandboxVal = meta.sandbox !== undefined && meta.sandbox !== null ? String(meta.sandbox) : 'Default';

    if (meta.hasStarted !== false) {
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
  }

  const statusCard = `### 📊 Task Status Info
* **Tool:** \`${tool}\`
* **Status:** \`${status}\`
* **Model Configured:** \`${modelStr}\`
* **Sandbox Policy:** \`${sandboxVal}\`
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
 * COMMAND HANDLER: /rename
 */
async function handleRenameCommand(interaction) {
  const threadId = interaction.channelId;
  const newName = interaction.options.getString('name');
  const channel = interaction.channel;

  if (!channel || !channel.isThread()) {
    return interaction.reply({
      content: '❌ This command can only be used inside a thread.',
      ephemeral: true
    });
  }

  const meta = threadMetadata.get(threadId);
  if (!meta) {
    return interaction.reply({
      content: '❌ No agent session metadata found for this thread.',
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    // 1. Rename Discord Thread
    await channel.setName(newName);

    // 2. Update Metadata (if we want to store it)
    meta.threadName = newName;
    saveMetadata();

    await interaction.editReply(`✅ **Thread renamed successfully to:** \`${newName}\``);
  } catch (err) {
    console.error('Rename failed:', err);
    await interaction.editReply(`❌ **Failed to rename thread:** ${err.message}`);
  }
}

/**
 * COMMAND HANDLER: /delete
 */
async function handleDeleteCommand(interaction) {
  const channel = interaction.channel;

  if (!channel || !channel.isThread()) {
    return interaction.reply({
      content: '❌ This command can only be used inside a thread.',
      ephemeral: true
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('thread:confirm-delete')
      .setLabel('Confirm Delete')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️'),
    new ButtonBuilder()
      .setCustomId('thread:cancel-delete')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );

  return interaction.reply({
    content: '⚠️ **Are you sure you want to delete this thread?** This will archive the thread and remove its session metadata.',
    components: [row],
    ephemeral: true
  });
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

  try {
    await interaction.deferReply();
  } catch (err) {
    console.warn('Failed to defer reply for export command:', err.message);
    return;
  }

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
 * Helper to execute git pull and then restart the gateway process.
 */
async function performGitPullAndRestart(triggerSource) {
  let outputText = '';
  try {
    const { exec } = require('child_process');
    outputText = await new Promise((resolve) => {
      // Run git pull in the project root directory
      exec('git pull', { cwd: path.join(__dirname, '..') }, (error, stdout, stderr) => {
        let out = '';
        if (error) {
          out += `❌ **Git Pull Error:** ${error.message}\n`;
        }
        if (stdout && stdout.trim()) {
          out += `stdout:\n\`\`\`\n${stdout.trim()}\n\`\`\`\n`;
        }
        if (stderr && stderr.trim()) {
          out += `stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\`\n`;
        }
        if (!out) {
          out = 'Already up to date (no output).\n';
        }
        resolve(out);
      });
    });
  } catch (err) {
    outputText = `❌ Failed to perform git pull: ${err.message}\n`;
  }

  const statusMsg = `🔄 **Restarting Gateway [${currentGateway}]...**\n\n**Git Pull Output:**\n${outputText}`;
  console.log(statusMsg.replace(/\*+/g, ''));

  if (triggerSource && typeof triggerSource.editReply === 'function') {
    try {
      await triggerSource.editReply({ content: statusMsg });
    } catch (e) {}
  } else if (triggerSource && typeof triggerSource.send === 'function') {
    try {
      await triggerSource.send(statusMsg);
    } catch (e) {}
  } else {
    // If triggered via keyboard shortcut in terminal, send status to the gateway text channel
    try {
      const channelName = currentGateway.toLowerCase();
      const guild = client.guilds.cache.get(GUILD_ID);
      if (guild) {
        const gatewayChannel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);
        if (gatewayChannel) {
          await gatewayChannel.send(statusMsg);
        }
      }
    } catch (e) {
      console.error('Failed to notify Discord of keyboard restart:', e.message);
    }
  }

  // Allow a short delay for Discord API messages to flush
  setTimeout(() => {
    const { spawn } = require('child_process');
    const fs = require('fs');

    let stdioOption = 'ignore';
    try {
      if (process.stdout.isTTY) {
        const ttyFd = fs.openSync('/dev/tty', 'r+');
        stdioOption = [ttyFd, ttyFd, ttyFd];
      }
    } catch (e) {
      console.warn('Could not open /dev/tty for restart redirection, defaulting to ignore:', e.message);
    }

    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: stdioOption
    });
    child.unref();
    process.exit(0);
  }, 1000);
}

/**
 * COMMAND HANDLER: /restart
 */
async function handleRestartCommand(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.warn('Failed to defer reply for restart command:', err.message);
  }
  await performGitPullAndRestart(interaction);
}

/**
 * COMMAND HANDLER: /model
 */
async function handleModelCommand(interaction) {
  const threadId = interaction.channelId;
  let newModelName = interaction.options.getString('name');
  
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
    if (newModelName === '__default__') {
      newModelName = null;
      delete meta.model;
    } else {
      meta.model = newModelName;
    }
    saveMetadata();

    const newModelDisplay = newModelName || 'Default';
    let response = `✅ **Model updated successfully!**\n* **Thread Model:** \`${oldModel}\` ➔ \`${newModelDisplay}\`\nThis model will be used for subsequent continuation runs.`;
    
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

/**
 * COMMAND HANDLER: /permission
 */
async function handlePermissionCommand(interaction) {
  const threadId = interaction.channelId;
  let newPolicy = interaction.options.getString('policy');
  
  const meta = threadMetadata.get(threadId);
  const task = processManager.activeTasks.get(threadId);

  if (!meta) {
    return interaction.reply({
      content: '❌ This channel is not a registered agent task thread.',
      ephemeral: true
    });
  }

  const isAgy = meta.tool === 'agy';
  const isGemini = meta.tool === 'gemini';

  if (newPolicy !== null && newPolicy !== undefined) {
    // Validation for specific tools if needed, otherwise just store it
    if (isAgy) {
      if (newPolicy.toLowerCase() === 'true') {
        newPolicy = true;
      } else if (newPolicy.toLowerCase() === 'false') {
        newPolicy = false;
      }
    }

    const oldPolicy = meta.sandbox !== undefined && meta.sandbox !== null ? String(meta.sandbox) : 'Default';
    meta.sandbox = newPolicy;
    saveMetadata();

    let response = `✅ **Permission policy updated successfully!**\n* **Thread Permission Policy:** \`${oldPolicy}\` ➔ \`${newPolicy}\`\nThis policy will be used for subsequent continuation runs in this thread.`;
    
    if (task) {
      const activePolicy = task.sandbox !== undefined && task.sandbox !== null ? String(task.sandbox) : 'Default';
      response += `\n\n⚠️ *Note: An active process is currently running with policy \`${activePolicy}\`. The new policy will take effect once the current task finishes and a new one is resumed.*`;
    }

    return interaction.reply(response);
  } else {
    const currentPolicy = meta.sandbox !== undefined && meta.sandbox !== null ? String(meta.sandbox) : 'Default';
    let response = `🔒 **Current thread permission policy configuration:** \`${currentPolicy}\``;
    
    if (task) {
      const activePolicy = task.sandbox !== undefined && task.sandbox !== null ? String(task.sandbox) : 'Default';
      response += `\n* **Active running process permission policy:** \`${activePolicy}\``;
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

/**
 * COMMAND HANDLER: /sessions
 */
async function handleSessionsCommand(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.warn('Failed to defer reply for sessions command:', err.message);
    return;
  }
  await updateSessionsList(interaction);
}

async function updateSessionsList(interactionOrMessage) {
  const { project: inferredProject } = resolveGatewayAndProject(interactionOrMessage.channel);
  
  const embed = new EmbedBuilder()
    .setTitle(inferredProject ? `📂 Sessions for Project: ${inferredProject}` : `📂 Global Agent Sessions History [${currentGateway}]`)
    .setColor('#2b2d31')
    .setDescription(inferredProject ? `Showing most recent sessions for the **${inferredProject}** directory.` : 'Below is a list of your most recent agent sessions across all projects.')
    .setTimestamp();

  // Filter entries if we are in a project channel
  let metadataEntries = [...threadMetadata.entries()].reverse();
  
  if (inferredProject) {
    metadataEntries = metadataEntries.filter(([id, meta]) => {
      const projectDir = meta.directory.split('/').pop() || '';
      return projectDir.toLowerCase() === inferredProject.toLowerCase();
    });
  }

  metadataEntries = metadataEntries.slice(0, 10);
  const rows = [];

  if (metadataEntries.length === 0) {
    embed.setDescription(inferredProject ? `No session history found for project: **${inferredProject}**` : 'No session history found.');
  } else {
    metadataEntries.forEach(([id, meta]) => {
      const tool = (meta.tool === 'agy' ? 'antigravity' : meta.tool).toUpperCase();
      const project = meta.directory.split('/').pop() || 'Unknown';
      const status = processManager.activeTasks.has(id) ? '🟢 Running' : '⚪ Idle';
      const name = meta.threadName || `Thread #${id}`;
      
      embed.addFields({
        name: `${status} | ${tool} | ${project}`,
        value: `**Name:** ${name}\n**Channel:** <#${id}>`
      });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel(`Jump`)
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/channels/${interactionOrMessage.guildId}/${id}`),
        new ButtonBuilder()
          .setCustomId(`session:delete:${id}`)
          .setLabel('Delete')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('🗑️')
      );
      rows.push(row);
    });
  }

  const response = { embeds: [embed], components: rows.slice(0, 5) }; // Limit to 5 rows for Discord
  
  try {
    if (interactionOrMessage.editReply) {
      await interactionOrMessage.editReply(response);
    } else {
      await interactionOrMessage.edit(response);
    }
  } catch (e) {
    console.error('Failed to update sessions list UI:', e);
  }
}

async function handleSessionButton(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const targetThreadId = parts[2];

  if (action === 'delete') {
    const meta = threadMetadata.get(targetThreadId);
    if (!meta) {
      return interaction.reply({ content: '❌ Session metadata not found.', ephemeral: true });
    }

    // Kill if active
    if (processManager.activeTasks.has(targetThreadId)) {
      await processManager.killTask(targetThreadId);
    }

    // Cleanup metadata
    threadMetadata.delete(targetThreadId);
    saveMetadata();

    // Delete thread
    try {
      const thread = await interaction.guild.channels.fetch(targetThreadId);
      if (thread) await thread.delete();
    } catch (e) {}

    await interaction.reply({ content: `✅ Session and thread for \`${targetThreadId}\` deleted.`, ephemeral: true });
  }
}

let dashboardMessage = null;
async function initDashboard(gatewayChannel) {
  try {
    // Try to find existing dashboard in the last 50 messages
    const messages = await gatewayChannel.messages.fetch({ limit: 50 });
    dashboardMessage = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Global Dashboard'));

    if (!dashboardMessage) {
      dashboardMessage = await gatewayChannel.send({ content: 'Initializing Global Dashboard...' });
    }

    setInterval(() => updateDashboard(), 10000);
    updateDashboard();
  } catch (e) {
    console.error('Failed to initialize dashboard:', e);
  }
}

async function updateDashboard() {
  if (!dashboardMessage) return;

  const embed = new EmbedBuilder()
    .setTitle(`🛰️ Gateway Global Dashboard [${currentGateway}]`)
    .setColor('#2b2d31')
    .setTimestamp();

  const activeTasks = [...processManager.activeTasks.values()];
  
  if (activeTasks.length === 0) {
    embed.setDescription('✅ **All systems operational.** No active agent tasks running.');
  } else {
    let taskList = '';
    activeTasks.forEach(task => {
      const duration = processManager.formatDuration(Date.now() - task.startTime);
      taskList += `🔸 **${(task.tool === 'agy' ? 'antigravity' : task.tool).toUpperCase()}** in <#${task.threadId}>\n`;
      taskList += `   └ Status: \`${task.status}\` | Duration: \`${duration}\`\n\n`;
    });
    embed.setDescription(taskList);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('dashboard:refresh')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔄'),
    new ButtonBuilder()
      .setCustomId('dashboard:sessions')
      .setLabel('View Sessions')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📂')
  );

  try {
    await dashboardMessage.edit({ content: null, embeds: [embed], components: [row] });
  } catch (e) {
    console.error('Failed to update dashboard:', e);
  }
}

async function handleDashboardButton(interaction) {
  const action = interaction.customId.substring('dashboard:'.length);
  if (action === 'refresh') {
    try {
      await interaction.deferUpdate();
    } catch (e) {}
    await updateDashboard();
  } else if (action === 'sessions') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      console.warn('Failed to defer reply for dashboard sessions button:', e.message);
      return;
    }
    await updateSessionsList(interaction);
  }
}

// COMMAND HANDLER: /usage
async function handleUsageCommand(interaction) {
  try {
    await interaction.deferReply();
  } catch (err) {
    console.warn('Failed to defer reply for usage command:', err.message);
    return;
  }

  const threadId = interaction.channelId;
  const meta = threadMetadata.get(threadId);

  let threadTokens = 0;
  let globalTokens = 0;
  let toolTotals = { agy: 0, codex: 0, gemini: 0 };
  let threadTotalsMap = new Map(); // threadId -> { tool, tokens }
  let threadModelTotals = new Map(); // modelName -> tokens

  try {
    if (fs.existsSync(USAGE_FILE)) {
      const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      data.forEach(record => {
        globalTokens += record.tokens;
        if (record.tool === 'agy') toolTotals.agy += record.tokens;
        if (record.tool === 'codex') toolTotals.codex += record.tokens;
        if (record.tool === 'gemini') toolTotals.gemini += record.tokens;

        if (record.threadId) {
          if (record.threadId === threadId) {
            threadTokens += record.tokens;
            let modelKey = record.model;
            if (!modelKey) {
              if (record.tool === 'agy') modelKey = 'Gemini 3.5 Flash';
              else if (record.tool === 'gemini') modelKey = 'Gemini CLI Default';
              else modelKey = 'Default Codex Model';
            }
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
    overviewText += `  * *Gemini CLI (gemini):* \`${toolTotals.gemini.toLocaleString()} tokens\`\n`;
    overviewText += `  * *Codex CLI (codex):* \`${toolTotals.codex.toLocaleString()} tokens\`\n\n`;

    overviewText += `**Active Sessions Usage Breakdown:**\n`;
    if (threadTotalsMap.size === 0) {
      overviewText += `* *No logged session usage found in registry.*`;
    } else {
      for (const [id, stats] of threadTotalsMap.entries()) {
        const threadMeta = threadMetadata.get(id);
        const toolDisplay = stats.tool === 'agy' ? 'antigravity' : stats.tool;
        const name = threadMeta ? `[${toolDisplay.toUpperCase()}] ${threadMeta.directory.split('/').pop()}` : `Thread #${id}`;
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

/**
 * COMMAND HANDLER: /info
 */
async function handleInfoCommand(interaction) {
  const channel = interaction.channel;
  if (!channel) return interaction.reply({ content: '❌ Channel not found.', ephemeral: true });

  const { gateway, project: inferredProject } = resolveGatewayAndProject(channel);
  if (!inferredProject) {
    return interaction.reply({
      content: '❌ This command can only be run inside a project text channel under a Gateway Category.',
      ephemeral: true
    });
  }

  // Resolve directory path
  const PROJECTS_ROOT = process.env.PROJECTS_ROOT;
  let resolvedDirectory = null;

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

  if (!resolvedDirectory) {
    return interaction.reply({
      content: `❌ Could not resolve the local project directory for project: \`${inferredProject}\`.`,
      ephemeral: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`📁 Project Dashboard: ${inferredProject}`)
    .setDescription(`Use the buttons below to interactively fetch information about this project. Responses are sent **ephemerally** to prevent channel clutter.`)
    .setColor('#2b2d31')
    .addFields(
      { name: 'Gateway', value: `\`${gateway || 'Default'}\``, inline: true },
      { name: 'Directory', value: `\`${resolvedDirectory}\``, inline: true }
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('project:new-session')
      .setLabel('New Session')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🚀'),
    new ButtonBuilder()
      .setCustomId('project:history')
      .setLabel('History')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📂'),
    new ButtonBuilder()
      .setCustomId('project:readme')
      .setLabel('README')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📖'),
    new ButtonBuilder()
      .setCustomId('project:files')
      .setLabel('Files')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📁'),
    new ButtonBuilder()
      .setCustomId('project:git')
      .setLabel('Git')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🌿')
  );

  return interaction.reply({ embeds: [embed], components: [row] });
}

/**
 * Handle button clicks for project-specific information dashboard (readme, files, git status)
 */
async function handleProjectButton(interaction) {
  const action = interaction.customId.substring('project:'.length);
  const channel = interaction.channel;
  if (!channel) {
    return interaction.reply({ content: '❌ Channel not found.', ephemeral: true });
  }

  const { gateway, project: inferredProject } = resolveGatewayAndProject(channel);
  if (!inferredProject) {
    return interaction.reply({
      content: '❌ This channel does not appear to be a registered project text channel under a Gateway Category.',
      ephemeral: true
    });
  }

  // Resolve directory path
  const PROJECTS_ROOT = process.env.PROJECTS_ROOT;
  let resolvedDirectory = null;

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

  if (!resolvedDirectory) {
    return interaction.reply({
      content: `❌ Could not resolve the local project directory for project: \`${inferredProject}\`. Please verify your PROJECTS_ROOT setting.`,
      ephemeral: true
    });
  }

  try {
    if (action === 'new-session') {
      const modal = new ModalBuilder()
        .setCustomId('session-modal')
        .setTitle(`New Session: ${inferredProject}`);

      const toolInput = new TextInputBuilder()
        .setCustomId('tool')
        .setLabel('Tool (gemini, agy, codex)')
        .setPlaceholder('gemini')
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

      const promptInput = new TextInputBuilder()
        .setCustomId('prompt')
        .setLabel('Initial Task / Prompt')
        .setPlaceholder('Enter your first prompt here...')
        .setRequired(false)
        .setStyle(TextInputStyle.Paragraph);

      const row1 = new ActionRowBuilder().addComponents(toolInput);
      const row2 = new ActionRowBuilder().addComponents(promptInput);

      modal.addComponents(row1, row2);
      return interaction.showModal(modal);

    } else if (action === 'history') {
      await interaction.deferReply({ ephemeral: true });
      return updateSessionsList(interaction);

    } else if (action === 'readme') {
      // Defer ephemeral reply
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (err) {
        console.warn('Failed to defer reply for project button:', err.message);
        return;
      }
      const files = fs.readdirSync(resolvedDirectory);
      const readmeFile = files.find(f => {
        const lower = f.toLowerCase();
        return lower === 'readme.md' || lower === 'readme' || lower === 'readme.txt' || lower === 'readme.markdown';
      });

      if (!readmeFile) {
        return interaction.editReply({
          content: `❌ No README file found in \`${resolvedDirectory}\`.`
        });
      }

      const readmePath = path.join(resolvedDirectory, readmeFile);
      let content = fs.readFileSync(readmePath, 'utf8');
      
      if (content.trim().length === 0) {
        return interaction.editReply({
          content: `📖 **${readmeFile}** is empty.`
        });
      }

      const maxLength = 1900;
      let truncated = false;
      if (content.length > maxLength) {
        content = content.substring(0, maxLength);
        truncated = true;
      }

      const replyText = `📖 **README.md for ${inferredProject}**:\n\`\`\`markdown\n${content}\n\`\`\`${truncated ? '\n*(truncated due to Discord character limit)*' : ''}`;
      return interaction.editReply({ content: replyText });

    } else if (action === 'files') {
      const files = fs.readdirSync(resolvedDirectory);
      const items = [];
      for (const file of files) {
        if (file === '.git' || file === 'node_modules') continue;
        const fullPath = path.join(resolvedDirectory, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            items.push(`📁 ${file}/`);
          } else {
            items.push(`📄 ${file}`);
          }
        } catch (e) {}
      }

      if (items.length === 0) {
        return interaction.editReply({
          content: `📁 **${inferredProject}** is empty.`
        });
      }

      // Sort directories first, then files
      items.sort((a, b) => {
        if (a.startsWith('📁') && !b.startsWith('📁')) return -1;
        if (!a.startsWith('📁') && b.startsWith('📁')) return 1;
        return a.localeCompare(b);
      });

      const listText = items.join('\n');
      const maxLength = 1900;
      let displayList = listText;
      let truncated = false;
      if (listText.length > maxLength) {
        displayList = listText.substring(0, maxLength);
        truncated = true;
      }

      const replyText = `📁 **Workspace Directory Tree (${inferredProject})**:\n\`\`\`\n${displayList}\n\`\`\`${truncated ? '\n*(truncated)*' : ''}`;
      return interaction.editReply({ content: replyText });

    } else if (action === 'git') {
      const isGit = fs.existsSync(path.join(resolvedDirectory, '.git'));
      if (!isGit) {
        return interaction.editReply({
          content: `❌ Directory \`${resolvedDirectory}\` is not a git repository.`
        });
      }

      const { exec } = require('child_process');
      exec('git status -s', { cwd: resolvedDirectory }, (error, stdout, stderr) => {
        if (error) {
          return interaction.editReply({
            content: `❌ Error running git status: \`${error.message}\``
          });
        }
        
        const cleanStdout = stdout.trim();
        if (cleanStdout.length === 0) {
          return interaction.editReply({
            content: `🌿 **Git Status (${inferredProject})**:\n\`\`\`\nWorking directory clean. Everything up-to-date.\n\`\`\``
          });
        }

        const maxLength = 1900;
        let displayStatus = cleanStdout;
        let truncated = false;
        if (cleanStdout.length > maxLength) {
          displayStatus = cleanStdout.substring(0, maxLength);
          truncated = true;
        }

        return interaction.editReply({
          content: `🌿 **Git Status (${inferredProject})**:\n\`\`\`\n${displayStatus}\n\`\`\`${truncated ? '\n*(truncated)*' : ''}`
        });
      });
    }
  } catch (err) {
    console.error('Error in handleProjectButton:', err);
    return interaction.editReply({
      content: `❌ Error processing request: ${err.message}`
    });
  }
}

// Clean up metadata when a thread is deleted
client.on('threadDelete', async (thread) => {
  if (threadMetadata.has(thread.id)) {
    console.log(`[Thread Delete] Cleaning up session metadata for thread ${thread.id}`);
    threadMetadata.delete(thread.id);
    saveMetadata();
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
        console.warn('======================================================================\\n');
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
