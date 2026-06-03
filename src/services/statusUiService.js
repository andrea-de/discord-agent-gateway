const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { currentGateway, threadMetadata, uiState, getClient } = require('../utils/state');
const { listProjectDirectories, resolveGatewayAndProject } = require('./projectService');
const processManager = require('../processManager');
const ptyManager = require('../ptyManager');

async function updateSessionsList(interactionOrMessage) {
  const channel = interactionOrMessage.channel;
  const client = getClient();
  const { project: inferredProject } = resolveGatewayAndProject(channel);
  
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
      const isRunning = processManager.activeTasks.has(id) || ptyManager.activeSessions.has(id);
      const status = isRunning ? '🟢 Running' : '⚪ Idle';
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

  const response = { embeds: [embed], components: rows.slice(0, 5) };
  
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

async function updateGatewayInfoMessage() {
  if (!uiState.infoMessage) return;

  const projects = listProjectDirectories();
  const visibleProjects = projects.slice(0, 25);
  const projectList = visibleProjects.length
    ? visibleProjects.map(name => `• ${name}`).join('\n')
    : 'No project directories found.';

  const embed = new EmbedBuilder()
    .setTitle(`📁 Gateway Projects: ${currentGateway}`)
    .setColor('#2b2d31')
    .setDescription(projectList)
    .addFields(
      { name: 'Projects Root', value: `\`${process.env.PROJECTS_ROOT || 'Not configured'}\`` }
    );

  if (projects.length > visibleProjects.length) {
    embed.setFooter({ text: `Showing ${visibleProjects.length} of ${projects.length} projects.` });
  }

  const rows = [];
  let currentRow = new ActionRowBuilder();

  visibleProjects.forEach((projectName, index) => {
    if (index > 0 && index % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`gateway:open-project:${currentGateway}:${projectName}`)
        .setLabel(projectName)
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📁')
    );
  });

  if (currentRow.components.length > 0) {
    rows.push(currentRow);
  }

  try {
    await uiState.infoMessage.edit({ content: null, embeds: [embed], components: rows });
  } catch (err) {
    console.error('Failed to update projects message:', err);
  }
}

async function initGatewayMessages(gatewayChannel) {
  try {
    const client = getClient();
    const messages = await gatewayChannel.messages.fetch({ limit: 50 });

    uiState.onlineMessage = messages.find(m => 
      m.author.id === client.user.id && 
      (m.content && (m.content.includes('is online and ready to receive tasks') || m.content.includes('Restarting Gateway')))
    );

    uiState.infoMessage = messages.find(m => 
      m.author.id === client.user.id && 
      (m.embeds[0]?.title?.includes('Gateway Info') || m.embeds[0]?.title?.includes('Gateway Projects') || (m.content && m.content.includes('Initializing Gateway Info')))
    );

    uiState.sessionsMessage = messages.find(m => 
      m.author.id === client.user.id && 
      (m.embeds[0]?.title?.includes('Global Agent Sessions History') || m.embeds[0]?.title?.includes('Sessions History') || (m.content && m.content.includes('Initializing Sessions History')))
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('gateway:info')
        .setLabel('Info')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🛰️'),
      new ButtonBuilder()
        .setCustomId('gateway:sessions')
        .setLabel('Sessions')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📂')
    );

    const onlineContent = `🟢 **Agent Gateway [${currentGateway}] is online and ready to receive tasks.**\nAll commands run inside this category or channel will automatically target this instance.\n*(Last Start: <t:${Math.floor(Date.now() / 1000)}:F>)*`;

    if (uiState.onlineMessage) {
      await uiState.onlineMessage.edit({ content: onlineContent, components: [row] });
      console.log('Reused and updated existing startup online message.');
    } else {
      uiState.onlineMessage = await gatewayChannel.send({ content: onlineContent, components: [row] });
      console.log('Sent new startup online message.');
    }

    if (!uiState.infoMessage) {
      uiState.infoMessage = await gatewayChannel.send({ content: 'Initializing Gateway Info...' });
    }
    await updateGatewayInfoMessage();

    if (!uiState.sessionsMessage) {
      uiState.sessionsMessage = await gatewayChannel.send({ content: 'Initializing Sessions History...' });
    }
    await updateSessionsList(uiState.sessionsMessage);

  } catch (err) {
    console.error('Failed to initialize gateway messages:', err);
  }
}

async function initSessionsPeriodicRefresh(gatewayChannel) {
  try {
    const client = getClient();
    const messages = await gatewayChannel.messages.fetch({ limit: 50 });
    const oldDash = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('Global Dashboard'));
    if (oldDash) {
      await oldDash.delete().catch(() => {});
      console.log('Deleted old Global Dashboard message.');
    }

    setInterval(() => {
      if (uiState.sessionsMessage) {
        updateSessionsList(uiState.sessionsMessage).catch(console.error);
      }
    }, 10000);
  } catch (e) {
    console.error('Failed to initialize sessions periodic refresh:', e);
  }
}

module.exports = {
  updateSessionsList,
  updateGatewayInfoMessage,
  initGatewayMessages,
  initSessionsPeriodicRefresh,
};
