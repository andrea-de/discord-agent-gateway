const fs = require('fs');
const path = require('path');
const os = require('os');
const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { currentGateway } = require('../utils/state');
const { KNOWN_GATEWAYS, CUSTOM_IDS } = require('../utils/constants');

function resolveProjectDirectory(projectName) {
  console.log(`[resolveProjectDirectory] Attempting to resolve project: "${projectName}"`);
  const PROJECTS_ROOT = process.env.PROJECTS_ROOT;
  console.log(`[resolveProjectDirectory] process.env.PROJECTS_ROOT: "${PROJECTS_ROOT}"`);
  if (!PROJECTS_ROOT || !projectName) {
    console.log(`[resolveProjectDirectory] PROJECTS_ROOT or projectName missing`);
    return null;
  }
  const cleanProjectName = projectName.trim();

  let resolvedRoot = PROJECTS_ROOT;
  if (PROJECTS_ROOT.startsWith('~')) {
    resolvedRoot = path.join(os.homedir(), PROJECTS_ROOT.substring(1));
  }
  console.log(`[resolveProjectDirectory] resolvedRoot: "${resolvedRoot}"`);

  const targetPath = path.join(resolvedRoot, cleanProjectName);
  console.log(`[resolveProjectDirectory] targetPath: "${targetPath}"`);
  if (fs.existsSync(targetPath)) {
    const isDir = fs.statSync(targetPath).isDirectory();
    console.log(`[resolveProjectDirectory] targetPath exists. Is Directory: ${isDir}`);
    if (isDir) {
      return targetPath;
    }
  } else {
    console.log(`[resolveProjectDirectory] targetPath does not exist.`);
  }

  if (fs.existsSync(resolvedRoot) && fs.statSync(resolvedRoot).isDirectory()) {
    console.log(`[resolveProjectDirectory] resolvedRoot exists. Scanning subdirectories for case-insensitive match...`);
    const match = fs.readdirSync(resolvedRoot)
      .find(item => item.toLowerCase() === cleanProjectName.toLowerCase());
    if (match) {
      const matchedPath = path.join(resolvedRoot, match);
      const isDir = fs.statSync(matchedPath).isDirectory();
      console.log(`[resolveProjectDirectory] Case-insensitive match found: "${match}". Is Directory: ${isDir}`);
      if (isDir) {
        return matchedPath;
      }
    } else {
      console.log(`[resolveProjectDirectory] No case-insensitive match found.`);
    }
  } else {
    console.log(`[resolveProjectDirectory] resolvedRoot does not exist or is not a directory.`);
  }

  return null;
}

function getResolvedProjectsRoot() {
  const PROJECTS_ROOT = process.env.PROJECTS_ROOT;
  if (!PROJECTS_ROOT) return null;

  if (PROJECTS_ROOT.startsWith('~')) {
    return path.join(os.homedir(), PROJECTS_ROOT.substring(1));
  }
  return PROJECTS_ROOT;
}

function listProjectDirectories() {
  const resolvedRoot = getResolvedProjectsRoot();
  if (!resolvedRoot) return [];

  try {
    return fs.readdirSync(resolvedRoot).filter(item => {
      const fullPath = path.join(resolvedRoot, item);
      try {
        return fs.statSync(fullPath).isDirectory() && !item.startsWith('.');
      } catch (e) {
        return false;
      }
    });
  } catch (e) {
    console.error('Failed to list project directories:', e);
    return [];
  }
}

function resolveGatewayAndProject(channel) {
  if (!channel || typeof channel.isThread !== 'function') return { gateway: null, project: null };
  
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
    if (KNOWN_GATEWAYS.includes(channelNameClean)) {
      gateway = channelNameClean;
    } else {
      // Check if text channel name ends with any known gateway suffix (e.g. -helsinki)
      for (const gw of KNOWN_GATEWAYS) {
        const suffix = `-${gw.toLowerCase()}`;
        if (textChannel.name.toLowerCase().endsWith(suffix)) {
          gateway = gw;
          project = textChannel.name.substring(0, textChannel.name.length - suffix.length);
          break;
        }
      }

      // Fallback: check if the possible project name is a directory under the current gateway
      if (!gateway) {
        const suffix = `-${currentGateway.toLowerCase()}`;
        const possibleProject = textChannel.name.endsWith(suffix)
          ? textChannel.name.substring(0, textChannel.name.length - suffix.length)
          : textChannel.name;
        if (resolveProjectDirectory(possibleProject)) {
          gateway = currentGateway;
          project = possibleProject;
        }
      }
    }
  }
  
  return { gateway, project };
}

function isTargetForInteraction(interaction) {
  // 1. Explicit button target validation to prevent cross-gateway execution
  if (interaction.isButton()) {
    const customId = interaction.customId;
    if (customId.startsWith('gateway-project:')) {
      const parts = customId.split(':');
      const gw = parts[1];
      if (gw && KNOWN_GATEWAYS.includes(gw.toUpperCase())) {
        return gw.toUpperCase() === currentGateway;
      }
    }
    if (customId.startsWith('gateway:open-project:')) {
      const parts = customId.substring('gateway:open-project:'.length).split(':');
      const gw = parts[0];
      if (gw && KNOWN_GATEWAYS.includes(gw.toUpperCase())) {
        return gw.toUpperCase() === currentGateway;
      }
    }
  }

  // 1b. Explicit modal target validation to prevent cross-gateway execution
  if (interaction.isModalSubmit()) {
    const customId = interaction.customId;
    if (customId.startsWith('session-modal:')) {
      const parts = customId.split(':');
      const gw = parts[1];
      if (gw && KNOWN_GATEWAYS.includes(gw.toUpperCase())) {
        return gw.toUpperCase() === currentGateway;
      }
    }
  }

  // 2. Check explicitly chosen command option "gateway" first
  let chosenGateway = null;
  try {
    chosenGateway = interaction.options.getString('gateway');
    if (chosenGateway) {
      return chosenGateway.toUpperCase() === currentGateway;
    }
  } catch (e) {}

  // 3. Resolve gateway using resolveGatewayAndProject
  const { gateway: inferredGateway } = resolveGatewayAndProject(interaction.channel);
  if (inferredGateway) {
    return inferredGateway === currentGateway;
  }

  const channel = interaction.channel;
  if (!channel) return false;
  
  let textChannel = channel;
  if (channel.isThread()) {
    textChannel = channel.parent;
  }
  if (!textChannel) return false;

  let channelGateway = null;
  // Check parent category name (e.g. "HELSINKI GATEWAY")
  const parentCategory = textChannel.parent;
  if (parentCategory && parentCategory.name.endsWith(' GATEWAY')) {
    channelGateway = parentCategory.name.replace(' GATEWAY', '').trim().toUpperCase();
    if (channelGateway === currentGateway) {
      return true;
    }
  }

  // Check text channel name (e.g. #helsinki -> matches HELSINKI)
  const channelNameClean = textChannel.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (channelNameClean === currentGateway) {
    return true;
  }
  
  // If the channel name is matching *another* known gateway, we are NOT the target
  if (KNOWN_GATEWAYS.includes(channelNameClean) && channelNameClean !== currentGateway) {
    return false;
  }

  // Default: If run in general and no option is specified, let XPS act as default responder to explain
  if (!chosenGateway && !channelGateway) {
    return currentGateway === 'XPS';
  }

  return false;
}

async function getOrCreateProjectChannel(guild, resolvedDirectory) {
  const projectDirName = resolvedDirectory.split(/[/\\]/).filter(Boolean).pop() || 'general';
  const baseChannelName = projectDirName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const channelName = `${baseChannelName}-${currentGateway.toLowerCase()}`;
  const categoryName = `${currentGateway} GATEWAY`;
  
  let targetChannel = null;
  let permissionWarning = null;

  try {
    // Fetch channels to prevent cache misses
    const channels = await guild.channels.fetch();

    // 1. Find or create the Gateway category
    let category = channels.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
    if (!category) {
      try {
        category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory
        });
        channels.set(category.id, category);
      } catch (catErr) {
        console.warn(`Could not create category "${categoryName}":`, catErr.message);
        if (catErr.code === 50013 || catErr.status === 403) {
          permissionWarning = `Missing "Manage Channels" permission to create the "${categoryName}" category.`;
        }
      }
    }

    // 2. Find or create the project-specific text channel
    let projectChannel = channels.find(c => c.name === channelName && c.type === ChannelType.GuildText);
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

      await sendProjectDashboard(projectChannel, resolvedDirectory);
    }
    targetChannel = projectChannel;
  } catch (err) {
    console.error('Failed to provision project channel:', err);
    if (err.code === 50013 || err.status === 403) {
      permissionWarning = 'Missing "Manage Channels" permission to create project text channels.';
    }
  }

  return { targetChannel, permissionWarning };
}

async function updateProjectDashboard(channel) {
  try {
    const messages = await channel.messages.fetch({ limit: 20 });
    const client = channel.client;
    const dashboardMsg = messages.find(m => 
      m.author.id === client.user.id && 
      m.embeds[0] && 
      m.embeds[0].title && 
      m.embeds[0].title.startsWith('📁 Project Dashboard:')
    );

    if (!dashboardMsg) return;

    // Fetch active threads in the channel
    const fetched = await channel.threads.fetchActive();
    const threads = Array.from(fetched.threads.values());

    // Generate active threads section
    let threadsValue = '*No active sessions.*';
    if (threads.length > 0) {
      threadsValue = threads.map(t => `• <#${t.id}>`).join('\n');
    }

    // Clone the existing embed to avoid mutating read-only structures
    const oldEmbed = dashboardMsg.embeds[0];
    const newEmbed = EmbedBuilder.from(oldEmbed);

    // Update the "Active Sessions" field or add it
    const fields = oldEmbed.fields.filter(f => f.name !== 'Active Sessions');
    newEmbed.setFields(fields);
    newEmbed.addFields({ name: 'Active Sessions', value: threadsValue });

    await dashboardMsg.edit({ embeds: [newEmbed] });
  } catch (e) {
    console.error('Failed to update project dashboard:', e);
  }
}

async function sendProjectDashboard(channel, resolvedDirectory) {
  const projectDirName = resolvedDirectory.split(/[/\\]/).filter(Boolean).pop() || 'general';
  
  // Fetch active threads in the channel
  let threadsValue = '*No active sessions.*';
  try {
    const fetched = await channel.threads.fetchActive();
    const threads = Array.from(fetched.threads.values());
    if (threads.length > 0) {
      threadsValue = threads.map(t => `• <#${t.id}>`).join('\n');
    }
  } catch (e) {
    console.warn('Failed to fetch active threads for dashboard send:', e.message);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📁 Project Dashboard: ${projectDirName}`)
    .setDescription(`Welcome to the Project Channel for **${projectDirName}**!\nAll agent tasks run inside this directory will be spawned as threads here.\n\nUse the buttons below to interactively start agent sessions or query project info.`)
    .setColor('#2b2d31')
    .addFields(
      { name: 'Gateway', value: `\`${currentGateway}\``, inline: true },
      { name: 'Directory', value: `\`${resolvedDirectory}\``, inline: true },
      { name: 'Active Sessions', value: threadsValue }
    );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.START_TOOL(currentGateway, 'antigravity'))
      .setLabel('Antigravity')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🤖'),
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.START_TOOL(currentGateway, 'gemini'))
      .setLabel('Gemini')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('♊'),
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.START_TOOL(currentGateway, 'codex'))
      .setLabel('Codex')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🧠'),
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.START_TOOL(currentGateway, 'terminal'))
      .setLabel('Terminal')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📟')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.HISTORY(currentGateway))
      .setLabel('History')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📂'),
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.README(currentGateway))
      .setLabel('README')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📖'),
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.FILES(currentGateway))
      .setLabel('Files')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📁'),
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.GIT(currentGateway))
      .setLabel('Git')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🌿'),
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.PROJECT.CLEAN(currentGateway))
      .setLabel('Clean')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🧹')
  );

  return channel.send({ embeds: [embed], components: [row1, row2] });
}

async function updateAllProjectDashboards(guild) {
  try {
    const categoryName = `${currentGateway} GATEWAY`;
    const channels = await guild.channels.fetch();
    const category = channels.find(c => c.name === categoryName && c.type === ChannelType.GuildCategory);
    if (!category) return;

    const projectChannels = channels.filter(c => c.parentId === category.id && c.type === ChannelType.GuildText);

    for (const [id, channel] of projectChannels) {
      try {
        const messages = await channel.messages.fetch({ limit: 20 });
        const client = channel.client;
        const dashboardMsg = messages.find(m => 
          m.author.id === client.user.id && 
          m.embeds[0] && 
          m.embeds[0].title && 
          m.embeds[0].title.startsWith('📁 Project Dashboard:')
        );

        if (dashboardMsg) {
          // Fetch active threads in the channel
          let threadsValue = '*No active sessions.*';
          try {
            const fetched = await channel.threads.fetchActive();
            const threads = Array.from(fetched.threads.values());
            if (threads.length > 0) {
              threadsValue = threads.map(t => `• <#${t.id}>`).join('\n');
            }
          } catch (e) {}

          const oldEmbed = dashboardMsg.embeds[0];
          const newEmbed = EmbedBuilder.from(oldEmbed);

          // Update active threads field
          const fields = oldEmbed.fields.filter(f => f.name !== 'Active Sessions');
          newEmbed.setFields(fields);
          newEmbed.addFields({ name: 'Active Sessions', value: threadsValue });

          // Update components to Row 1 and Row 2 with Clean button
          const row1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.START_TOOL(currentGateway, 'antigravity'))
              .setLabel('Antigravity')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🤖'),
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.START_TOOL(currentGateway, 'gemini'))
              .setLabel('Gemini')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('♊'),
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.START_TOOL(currentGateway, 'codex'))
              .setLabel('Codex')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🧠'),
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.START_TOOL(currentGateway, 'terminal'))
              .setLabel('Terminal')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('📟')
          );

          const row2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.HISTORY(currentGateway))
              .setLabel('History')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('📂'),
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.README(currentGateway))
              .setLabel('README')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('📖'),
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.FILES(currentGateway))
              .setLabel('Files')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('📁'),
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.GIT(currentGateway))
              .setLabel('Git')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('🌿'),
            new ButtonBuilder()
              .setCustomId(CUSTOM_IDS.PROJECT.CLEAN(currentGateway))
              .setLabel('Clean')
              .setStyle(ButtonStyle.Danger)
              .setEmoji('🧹')
          );

          await dashboardMsg.edit({ embeds: [newEmbed], components: [row1, row2] });
        }
      } catch (err) {
        console.warn(`Failed to update dashboard for channel ${channel.name}:`, err.message);
      }
    }
    console.log(`[Project Service] Successfully refreshed dashboards for category: ${categoryName}`);
  } catch (err) {
    console.error('Failed to update all project dashboards on startup:', err);
  }
}

module.exports = {
  resolveProjectDirectory,
  listProjectDirectories,
  resolveGatewayAndProject,
  isTargetForInteraction,
  getOrCreateProjectChannel,
  updateProjectDashboard,
  sendProjectDashboard,
  updateAllProjectDashboards,
};
