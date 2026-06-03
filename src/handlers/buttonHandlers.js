const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const processManager = require('../processManager');
const ptyManager = require('../ptyManager');
const { currentGateway, threadMetadata, saveMetadata, uiState } = require('../utils/state');
const { resolveGatewayAndProject, resolveProjectDirectory, getOrCreateProjectChannel } = require('../services/projectService');
const { updateSessionsList, updateGatewayInfoMessage } = require('../services/statusUiService');

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

  try {
    const disabledRows = interaction.message.components.map(row => {
      const newRow = ActionRowBuilder.from(row.toJSON());
      newRow.components.forEach(btn => {
        btn.setDisabled(true);
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

  const success = await processManager.sendInput(threadId, value);
  if (!success) {
    await interaction.followUp({
      content: '❌ Failed to send input to the active task.',
      ephemeral: true
    });
  }
}

async function handleThreadButton(interaction) {
  const action = interaction.customId.substring('thread:'.length);
  const channel = interaction.channel;

  if (action === 'confirm-delete') {
    if (!channel || !channel.isThread()) return;
    
    const threadId = channel.id;
    await interaction.update({ content: '🗑️ **Deleting thread and cleaning up metadata...**', components: [] });

    const task = processManager.activeTasks.get(threadId);
    if (task) {
      await processManager.killTask(threadId);
    }
    const ptySession = ptyManager.activeSessions.get(threadId);
    if (ptySession) {
      await ptyManager.killSession(threadId);
    }

    if (threadMetadata.has(threadId)) {
      threadMetadata.delete(threadId);
      saveMetadata();
    }

    try {
      await channel.delete();
    } catch (err) {
      console.error('Failed to delete thread:', err);
    }

  } else if (action === 'cancel-delete') {
    await interaction.update({ content: '✅ **Deletion cancelled.**', components: [] });
  }
}

async function handleProjectButton(interaction) {
  const action = interaction.customId.substring('project:'.length);
  const channel = interaction.channel;
  if (!channel) {
    return interaction.reply({ content: '❌ Channel not found.', ephemeral: true });
  }

  const { project: inferredProject } = resolveGatewayAndProject(channel);
  if (!inferredProject) {
    return interaction.reply({
      content: '❌ This channel does not appear to be a registered project text channel under a Gateway Category.',
      ephemeral: true
    });
  }

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
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (err) {
        console.warn('Failed to defer reply for project files button:', err.message);
        return;
      }
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
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch (err) {
        console.warn('Failed to defer reply for project git button:', err.message);
        return;
      }
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
    try {
      return interaction.editReply({
        content: `❌ Error processing request: ${err.message}`
      });
    } catch (e) {
      try {
        return interaction.reply({
          content: `❌ Error processing request: ${err.message}`,
          ephemeral: true
        });
      } catch (replyErr) {}
    }
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

    if (processManager.activeTasks.has(targetThreadId)) {
      await processManager.killTask(targetThreadId);
    }

    threadMetadata.delete(targetThreadId);
    saveMetadata();

    try {
      const thread = await interaction.guild.channels.fetch(targetThreadId);
      if (thread) await thread.delete();
    } catch (e) {}

    await interaction.reply({ content: `✅ Session and thread for \`${targetThreadId}\` deleted.`, ephemeral: true });
  }
}

async function handleGatewayButton(interaction) {
  const action = interaction.customId.substring('gateway:'.length);
  if (action === 'info') {
    try {
      await interaction.deferUpdate();
    } catch (e) {}
    await updateGatewayInfoMessage();
  } else if (action === 'sessions') {
    try {
      await interaction.deferUpdate();
    } catch (e) {}
    if (uiState.sessionsMessage) {
      await updateSessionsList(uiState.sessionsMessage);
    }
  } else if (action.startsWith('open-project:')) {
    const parts = action.substring('open-project:'.length).split(':');
    const targetGateway = parts[0];
    const projectName = parts[1];

    if (targetGateway !== currentGateway) {
      return; // Ignore if not meant for us
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      console.warn('Failed to defer reply for open project:', e.message);
      return;
    }
    const resolvedDir = resolveProjectDirectory(projectName);
    if (!resolvedDir) {
      return interaction.editReply({ content: `❌ Could not resolve directory for project: \`${projectName}\`` });
    }
    const guild = interaction.guild;
    const { targetChannel } = await getOrCreateProjectChannel(guild, resolvedDir);
    await interaction.editReply({ content: `📁 Project channel opened: <#${targetChannel.id}>` });
  }
}

module.exports = {
  handleChoiceButton,
  handleThreadButton,
  handleProjectButton,
  handleSessionButton,
  handleGatewayButton,
};
