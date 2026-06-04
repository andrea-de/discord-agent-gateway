const path = require('path');
const fs = require('fs');
const processManager = require('../processManager');
const { threadMetadata, saveMetadata } = require('../utils/state');
const { resolveGatewayAndProject, resolveProjectDirectory } = require('../services/projectService');

async function handleSessionModal(interaction) {
  const parts = interaction.customId.split(':');
  const tool = parts[2] || 'gemini';
  const prompt = interaction.fields.getTextInputValue('prompt').trim();
  
  const { project: inferredProject } = resolveGatewayAndProject(interaction.channel);
  
  const resolvedDirectory = resolveProjectDirectory(inferredProject);

  if (!resolvedDirectory) {
    return interaction.reply({ content: '❌ Could not resolve directory for this project.', ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const displayToolName = tool === 'agy' ? 'antigravity' : tool;
    const threadName = prompt ? `[${displayToolName}] ${prompt.substring(0, 75)}` : `[${displayToolName}] Interactive Session`;
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
      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode: 'review', hasStarted: true, hideExecDetails: true });
    } else {
      await thread.send('⌨️ **Gateway Awaiting First Prompt**');
      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode: 'review', hasStarted: false, hideExecDetails: true });
    }
    saveMetadata();

    await interaction.editReply({ content: `✅ Session started in <#${thread.id}>` });
  } catch (err) {
    console.error('Modal task start failed:', err);
    await interaction.editReply({ content: `❌ Failed to start session: ${err.message}` });
  }
}

module.exports = {
  handleSessionModal,
};
