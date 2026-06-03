const path = require('path');
const fs = require('fs');
const processManager = require('../processManager');
const { threadMetadata, saveMetadata } = require('../utils/state');
const { resolveGatewayAndProject } = require('../services/projectService');

async function handleSessionModal(interaction) {
  const toolRaw = interaction.fields.getTextInputValue('tool').toLowerCase().trim();
  const tool = toolRaw === 'antigravity' ? 'agy' : toolRaw;
  const prompt = interaction.fields.getTextInputValue('prompt').trim();
  
  const { project: inferredProject } = resolveGatewayAndProject(interaction.channel);
  
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

module.exports = {
  handleSessionModal,
};
