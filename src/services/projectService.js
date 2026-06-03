const fs = require('fs');
const path = require('path');
const os = require('os');
const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { currentGateway } = require('../utils/state');
const { KNOWN_GATEWAYS } = require('../utils/constants');

function resolveProjectDirectory(projectName) {
  const PROJECTS_ROOT = process.env.PROJECTS_ROOT;
  if (!PROJECTS_ROOT || !projectName) return null;
  const cleanProjectName = projectName.trim();

  let resolvedRoot = PROJECTS_ROOT;
  if (PROJECTS_ROOT.startsWith('~')) {
    resolvedRoot = path.join(os.homedir(), PROJECTS_ROOT.substring(1));
  }

  const targetPath = path.join(resolvedRoot, cleanProjectName);
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory()) {
    return targetPath;
  }

  if (fs.existsSync(resolvedRoot) && fs.statSync(resolvedRoot).isDirectory()) {
    const match = fs.readdirSync(resolvedRoot)
      .find(item => item.toLowerCase() === cleanProjectName.toLowerCase());
    if (match) {
      const matchedPath = path.join(resolvedRoot, match);
      if (fs.statSync(matchedPath).isDirectory()) {
        return matchedPath;
      }
    }
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
  // 1. Check explicitly chosen option "gateway" first
  let chosenGateway = null;
  try {
    chosenGateway = interaction.options.getString('gateway');
    if (chosenGateway) {
      return chosenGateway.toUpperCase() === currentGateway;
    }
  } catch (e) {}

  // 2. Resolve gateway using resolveGatewayAndProject
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
  } catch (err) {
    console.error('Failed to provision project channel:', err);
    if (err.code === 50013 || err.status === 403) {
      permissionWarning = 'Missing "Manage Channels" permission to create project text channels.';
    }
  }

  return { targetChannel, permissionWarning };
}

module.exports = {
  resolveProjectDirectory,
  listProjectDirectories,
  resolveGatewayAndProject,
  isTargetForInteraction,
  getOrCreateProjectChannel,
};
