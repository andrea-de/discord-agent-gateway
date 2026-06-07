const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const processManager = require('../processManager');
const ptyManager = require('../ptyManager');
const { currentGateway, threadMetadata, saveMetadata, uiState, getOrInferMetadata } = require('../utils/state');
const { resolveGatewayAndProject, resolveProjectDirectory, getOrCreateProjectChannel, sendProjectDashboard } = require('../services/projectService');
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
  const customId = interaction.customId;
  const parts = customId.split(':');
  
  // Custom ID format: gateway-project:${gateway}:${action}:${optionalTool}
  const gateway = parts[1];
  const action = parts[2];
  const tool = parts[3];

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

  const resolvedDirectory = resolveProjectDirectory(inferredProject);

  if (!resolvedDirectory) {
    return interaction.reply({
      content: `❌ Could not resolve the local project directory for project: \`${inferredProject}\`. Please verify your PROJECTS_ROOT setting.`,
      ephemeral: true
    });
  }

  try {
    if (action === 'start') {
      if (tool === 'terminal') {
        // Start Bash Terminal directly
        await interaction.deferReply({ ephemeral: true });
        try {
          const threadName = `📟 [PTY] BASH in ${inferredProject}`;
          const thread = await channel.threads.create({
            name: threadName,
            autoArchiveDuration: 1440,
            reason: 'Interactive PTY Start from Dashboard'
          });

          await thread.send(`### 📟 Persistent PTY Session Initiated
* **Tool:** \`BASH\`
* **Directory:** \`${resolvedDirectory}\`
* **Type:** \`INTERACTIVE PTY\`
---
*Note: Any message sent in this thread will be piped directly to the terminal's stdin as keystrokes.*`);

          await ptyManager.startSession({
            thread,
            tool: 'bash',
            directory: resolvedDirectory
          });

          threadMetadata.set(thread.id, { 
            tool: 'bash', 
            directory: resolvedDirectory, 
            isPty: true,
            hasStarted: true 
          });
          saveMetadata();

          await interaction.editReply({ content: `✅ Terminal session started in <#${thread.id}>` });
        } catch (err) {
          console.error('PTY task start failed:', err);
          await interaction.editReply({ content: `❌ Failed to start terminal: ${err.message}` });
        }
      } else {
        // Start tool thread directly without a modal
        await interaction.deferReply({ ephemeral: true });
        try {
          const displayToolName = tool === 'antigravity' ? 'antigravity' : (tool === 'agy' ? 'antigravity' : tool);
          const threadName = `[${displayToolName}] Interactive Session`;
          const thread = await channel.threads.create({
            name: threadName,
            autoArchiveDuration: 1440,
            reason: 'Agent Gateway Direct Start'
          });

          const meta = {
            tool: tool === 'antigravity' ? 'agy' : (tool === 'agy' ? 'agy' : tool),
            directory: resolvedDirectory,
            mode: 'review',
            hasStarted: false
          };

          const controlRow = getThreadControlRow(thread.id, meta);

          await thread.send({
            content: `### 🤖 Session Initiated via Dashboard\n* **Tool:** \`${displayToolName.toUpperCase()}\`\n* **Directory:** \`${resolvedDirectory}\``,
            components: controlRow
          });

          await thread.send('⌨️ **Gateway Awaiting First Prompt**');

          threadMetadata.set(thread.id, meta);
          saveMetadata();

          await interaction.editReply({ content: `✅ Session started in <#${thread.id}>` });
        } catch (err) {
          console.error('Task start failed:', err);
          await interaction.editReply({ content: `❌ Failed to start session: ${err.message}` });
        }
      }

    } else if (action === 'clean') {
      await interaction.deferReply({ ephemeral: true });
      try {
        const channel = interaction.channel;
        const messages = await channel.messages.fetch({ limit: 100 });
        
        const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const toBulkDelete = [];
        const toDeleteIndividually = [];

        messages.forEach(msg => {
          if (msg.createdTimestamp > fourteenDaysAgo) {
            toBulkDelete.push(msg);
          } else {
            toDeleteIndividually.push(msg);
          }
        });

        if (toBulkDelete.length > 0) {
          await channel.bulkDelete(toBulkDelete);
        }
        for (const msg of toDeleteIndividually) {
          try {
            await msg.delete();
          } catch (e) {}
        }

        // Clean up orphaned log files in the project directory
        let deletedLogsCount = 0;
        try {
          const activeFetched = await channel.threads.fetchActive();
          const archivedFetched = await channel.threads.fetchArchived();
          const openThreadIds = new Set([
            ...activeFetched.threads.keys(),
            ...archivedFetched.threads.keys()
          ]);

          const activeLogFiles = new Set();
          for (const task of processManager.activeTasks.values()) {
            if (task.fullLogFile) activeLogFiles.add(path.resolve(task.fullLogFile));
          }
          for (const session of ptyManager.activeSessions.values()) {
            if (session.fullLogFile) activeLogFiles.add(path.resolve(session.fullLogFile));
          }

          if (fs.existsSync(resolvedDirectory)) {
            const files = fs.readdirSync(resolvedDirectory);
            const filenameRegex = /^\.gateway(?:-pty)?-(?:agy|codex|gemini|bash)-(?:(\d{17,22})-)?(\d+)\.log$/;

            for (const file of files) {
              const fullPath = path.join(resolvedDirectory, file);
              const resolvedPath = path.resolve(fullPath);

              if (activeLogFiles.has(resolvedPath)) {
                continue;
              }

              const match = file.match(filenameRegex);
              if (match) {
                const threadId = match[1];
                if (!threadId || !openThreadIds.has(threadId)) {
                  try {
                    fs.unlinkSync(fullPath);
                    deletedLogsCount++;
                  } catch (err) {
                    console.error(`Failed to delete orphaned log file ${file}:`, err.message);
                  }
                }
              }
            }
          }

          const logDir = '/tmp/discord-agent-gateway/logs';
          if (fs.existsSync(logDir)) {
            const files = fs.readdirSync(logDir);
            const filenameRegex = /^gateway(?:-pty)?-(?:agy|codex|gemini|bash)-(\d+)-\d+\.log$/;

            for (const file of files) {
              const fullPath = path.join(logDir, file);
              const resolvedPath = path.resolve(fullPath);

              if (activeLogFiles.has(resolvedPath)) {
                continue;
              }

              const match = file.match(filenameRegex);
              if (match) {
                const threadId = match[1];
                if (!threadId || !openThreadIds.has(threadId)) {
                  try {
                    fs.unlinkSync(fullPath);
                    deletedLogsCount++;
                  } catch (err) {
                    console.error(`Failed to delete orphaned log file ${file}:`, err.message);
                  }
                }
              }
            }
          }
        } catch (threadErr) {
          console.error('Failed to clean up orphaned log files:', threadErr);
        }

        // Reprint the dashboard
        await sendProjectDashboard(channel, resolvedDirectory);

        const logMsg = deletedLogsCount > 0 
          ? ` and deleted ${deletedLogsCount} orphaned log files` 
          : '';
        await interaction.editReply({ content: `🧹 Parent channel messages cleared${logMsg} and dashboard reprinted successfully.` });
      } catch (err) {
        console.error('Failed to clean channel messages:', err);
        await interaction.editReply({ content: `❌ Failed to clean channel: ${err.message}` });
      }

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
    const targetChannel = interaction.guild.channels.cache.get(targetThreadId) || await interaction.guild.channels.fetch(targetThreadId).catch(() => null);
    const meta = getOrInferMetadata(targetChannel);
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

async function handleProcessButton(interaction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  
  // Custom ID format: process:${action}:${threadId}
  const action = parts[1];
  const threadId = parts[2];

  if (action === 'stop') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      console.warn('Failed to defer reply for process stop:', e.message);
      return;
    }
    
    const task = processManager.activeTasks.get(threadId);
    if (!task) {
      return interaction.editReply({ content: '❌ No active agent task found for this thread.' });
    }

    const success = await processManager.killTask(threadId, { archiveThread: false });
    if (success) {
      await interaction.editReply({ content: '🛑 **Headless agent execution stopped successfully.**' });
    } else {
      await interaction.editReply({ content: '❌ Failed to stop the agent execution.' });
    }
  }
}

async function handleThreadControlButton(interaction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const action = parts[1];
  const threadId = parts[2];

  if (action === 'stop') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      return;
    }
    const task = processManager.activeTasks.get(threadId);
    if (!task) {
      return interaction.editReply({ content: '❌ No active agent task found for this thread.' });
    }
    const success = await processManager.killTask(threadId, { archiveThread: false });
    if (success) {
      await interaction.editReply({ content: '🛑 **Headless agent execution stopped successfully.**' });
    } else {
      await interaction.editReply({ content: '❌ Failed to stop agent execution.' });
    }
  } else if (action === 'export-modal') {
    const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
    const modal = new ModalBuilder()
      .setCustomId(`export-modal:${threadId}`)
      .setTitle('Export Session Options');

    const typeInput = new TextInputBuilder()
      .setCustomId('export-type')
      .setLabel('Export Type (all / clean / activity)')
      .setStyle(TextInputStyle.Short)
      .setValue('clean')
      .setPlaceholder('clean = chat only; activity = only file edits')
      .setRequired(true);

    const limitInput = new TextInputBuilder()
      .setCustomId('export-limit')
      .setLabel('Limit to Last N Messages (blank = all)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. 10')
      .setRequired(false);

    const row1 = new ActionRowBuilder().addComponents(typeInput);
    const row2 = new ActionRowBuilder().addComponents(limitInput);
    modal.addComponents(row1, row2);
    
    try {
      await interaction.showModal(modal);
    } catch (e) {
      console.error('Failed to show export modal:', e);
    }
  } else if (action === 'attach') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      return;
    }
    const meta = getOrInferMetadata(interaction.channel);
    if (!meta) {
      return interaction.editReply({ content: '❌ Session metadata not found.' });
    }
    const { getDriver } = require('../drivers');
    const driver = getDriver(meta.tool);
    const sessions = driver.getAvailableSessions(meta.directory);
    if (sessions.length === 0) {
      const displayTool = meta.tool === 'agy' ? 'antigravity' : meta.tool;
      return interaction.editReply({
        content: `❌ **No available sessions found**\n* **Tool:** \`${displayTool.toUpperCase()}\`\n* **Directory:** \`${meta.directory}\`\n\nNo native session history was detected in the tool's local database for this project path.`
      });
    }
    
    const { StringSelectMenuBuilder } = require('discord.js');
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`thread-control-select:attach:${threadId}`)
      .setPlaceholder('Select a session to attach to...')
      .addOptions(sessions.map(s => ({
        label: (s.label || s.description || s.id).substring(0, 100),
        value: s.id,
        description: (s.description || s.id).substring(0, 100)
      })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.editReply({
      content: '🔗 **Select a session to bind/attach to this thread:**',
      components: [row]
    });
  } else if (action === 'delete-cli-session') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      return;
    }
    const meta = getOrInferMetadata(interaction.channel);
    if (!meta) {
      return interaction.editReply({ content: '❌ Session metadata not found.' });
    }
    const { getDriver } = require('../drivers');
    const driver = getDriver(meta.tool);
    const sessions = driver.getAvailableSessions(meta.directory);
    if (sessions.length === 0) {
      const displayTool = meta.tool === 'agy' ? 'antigravity' : meta.tool;
      return interaction.editReply({
        content: `❌ **No available sessions found** to delete.\n* **Tool:** \`${displayTool.toUpperCase()}\`\n* **Directory:** \`${meta.directory}\``
      });
    }

    const { StringSelectMenuBuilder } = require('discord.js');
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`thread-control-select:delete-cli-session:${threadId}`)
      .setPlaceholder('Select a session to delete...')
      .addOptions(sessions.map(s => ({
        label: (s.label || s.description || s.id).substring(0, 100),
        value: s.id,
        description: (s.description || s.id).substring(0, 100)
      })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.editReply({
      content: '🔥 **Select a session to permanently delete from local database/files:**\n*(Warning: This action cannot be undone)*',
      components: [row]
    });
  } else if (action === 'change-model') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      return;
    }
    const meta = getOrInferMetadata(interaction.channel);
    if (!meta) {
      return interaction.editReply({ content: '❌ Session metadata not found.' });
    }
    const { getDriver } = require('../drivers');
    const driver = getDriver(meta.tool);
    
    let models = [];
    if (driver && typeof driver.getAvailableModels === 'function') {
      models = driver.getAvailableModels();
    }
    
    if (models.length === 0) {
      return interaction.editReply({
        content: `❌ **No available models found** for tool \`${meta.tool.toUpperCase()}\`.`
      });
    }
    
    const { StringSelectMenuBuilder } = require('discord.js');
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`thread-control-select:change-model:${threadId}`)
      .setPlaceholder('Select a model...')
      .addOptions([
        { label: 'Default Model', value: '__default__', description: 'Use the tool default model' },
        ...models.map(m => ({
          label: m.name.substring(0, 100),
          value: m.value,
          description: `Switch to ${m.name}`.substring(0, 100)
        }))
      ]);
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.editReply({
      content: '🤖 **Select a model to use for subsequent runs in this thread:**',
      components: [row]
    });
  } else if (action === 'toggle-detail') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      return;
    }
    const meta = getOrInferMetadata(interaction.channel);
    if (!meta) {
      return interaction.editReply({ content: '❌ Session metadata not found.' });
    }

    meta.hideExecDetails = !meta.hideExecDetails;
    saveMetadata();

    await updateThreadControlMessage(interaction.channel, meta);

    const mode = meta.hideExecDetails ? 'Clean (assistant text only)' : 'Verbose (including command/exec actions)';
    await interaction.editReply({
      content: `🔄 **Output detail mode toggled to:** \`${mode}\` for this thread.`
    });
  } else if (action === 'delete') {
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
    await interaction.reply({
      content: '⚠️ **Are you sure you want to delete this thread?** This will archive/delete the thread and remove its session metadata.',
      components: [row],
      ephemeral: true
    });
  }
}

async function handleThreadControlSelect(interaction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const action = parts[1];
  const threadId = parts[2];
  const selectedSessionId = interaction.values[0];

  if (action === 'attach') {
    try {
      await interaction.deferUpdate();
    } catch (e) {}
    const meta = getOrInferMetadata(interaction.channel);
    if (meta) {
      // Kill any existing active task for this *Discord thread* to prevent stray input
      if (processManager.activeTasks.has(interaction.channelId)) {
        await processManager.killTask(interaction.channelId, { archiveThread: false });
        console.log(`[Attach] Killed old task for thread ${interaction.channelId}`);
      } else if (processManager.activeTasks.has(threadId)) {
        // Fallback for any legacy cases
        await processManager.killTask(threadId, { archiveThread: false });
        console.log(`[Attach] Killed old task via parsed threadId ${threadId}`);
      }

      meta.sessionId = selectedSessionId;
      meta.hasStarted = true;
      console.log(`[Attach] Updating metadata for ${interaction.channelId}: sessionId=${selectedSessionId}`);
      threadMetadata.set(interaction.channelId, meta);
      saveMetadata();

      // Update thread control message on top with the new metadata and row
      await updateThreadControlMessage(interaction.channel, meta);

      await interaction.followUp({
        content: `✅ **Thread successfully bound/attached to session ID:** \`${selectedSessionId}\`\nResuming will now load this session's history.`,
        ephemeral: true
      });
    }
  } else if (action === 'change-model') {
    try {
      await interaction.deferUpdate();
    } catch (e) {}
    const meta = getOrInferMetadata(interaction.channel);
    if (meta) {
      const oldModel = meta.model || 'Default';
      const selectedModel = selectedSessionId;
      if (selectedModel === '__default__') {
        delete meta.model;
      } else {
        meta.model = selectedModel;
      }
      saveMetadata();
      await updateThreadControlMessage(interaction.channel, meta);
      
      const newModelDisplay = selectedModel === '__default__' ? 'Default' : selectedModel;
      await interaction.followUp({
        content: `✅ **Model updated successfully!**\n* **Thread Model:** \`${oldModel}\` ➔ \`${newModelDisplay}\``,
        ephemeral: true
      });
    }
  } else if (action === 'delete-cli-session') {
    try {
      await interaction.deferUpdate();
    } catch (e) {}
    const meta = getOrInferMetadata(interaction.channel);
    if (meta) {
      const { getDriver } = require('../drivers');
      const driver = getDriver(meta.tool);
      if (driver && typeof driver.deleteSession === 'function') {
        try {
          driver.deleteSession(selectedSessionId);
          
          if (meta.sessionId === selectedSessionId) {
            delete meta.sessionId;
            meta.hasStarted = false;
            threadMetadata.set(interaction.channelId, meta);
            saveMetadata();
            await updateThreadControlMessage(interaction.channel, meta);
          }

          await interaction.followUp({
            content: `✅ **Session successfully deleted!**\n* **Session ID:** \`${selectedSessionId}\`\nAll database entries, logs, and associated rollout/snapshot files have been permanently removed.`,
            ephemeral: true
          });
        } catch (err) {
          await interaction.followUp({
            content: `❌ **Failed to delete session:** ${err.message}`,
            ephemeral: true
          });
        }
      } else {
        await interaction.followUp({
          content: `❌ **Delete operation is not supported** for tool \`${meta.tool.toUpperCase()}\`.`,
          ephemeral: true
        });
      }
    }
  }
}

async function handlePtyCtrlButton(interaction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const action = parts[1];
  const tool = parts[2];
  const threadId = parts[3];

  const meta = getOrInferMetadata(interaction.channel);
  if (!meta) {
    return interaction.reply({ content: '❌ Session metadata not found.', ephemeral: true });
  }

  if (action === 'new') {
    try {
      await interaction.deferUpdate();
    } catch (e) {}
    await interaction.message.edit({
      content: `⏳ Spawning PTY terminal for \`${tool.toUpperCase()}\`...`,
      components: []
    });
    
    await ptyManager.startSession({
      thread: interaction.channel,
      tool,
      directory: meta.directory
    });
  } else if (action === 'attach') {
    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      return;
    }
    const { getDriver } = require('../drivers');
    const driver = getDriver(tool);
    const sessions = driver.getAvailableSessions(meta.directory);
    if (sessions.length === 0) {
      const displayTool = tool === 'agy' ? 'antigravity' : tool;
      await interaction.editReply({
        content: `❌ **No available sessions found**\n* **Tool:** \`${displayTool.toUpperCase()}\`\n* **Directory:** \`${meta.directory}\`\n\nNo native session history was detected. Starting a new PTY session instead...`
      });
      await interaction.message.edit({
        content: `⏳ Spawning PTY terminal for \`${tool.toUpperCase()}\`...`,
        components: []
      });
      await ptyManager.startSession({
        thread: interaction.channel,
        tool,
        directory: meta.directory
      });
      return;
    }
    
    const { StringSelectMenuBuilder } = require('discord.js');
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`pty-ctrl-select:attach:${tool}:${threadId}`)
      .setPlaceholder('Select a session to attach to...')
      .addOptions(sessions.map(s => ({
        label: (s.label || s.description || s.id).substring(0, 100),
        value: s.id,
        description: (s.description || s.id).substring(0, 100)
      })));
    const row = new ActionRowBuilder().addComponents(selectMenu);
    await interaction.editReply({
      content: '🔗 **Select a session to attach the PTY terminal to:**',
      components: [row]
    });
  }
}

async function handlePtyCtrlSelect(interaction) {
  const customId = interaction.customId;
  const parts = customId.split(':');
  const action = parts[1];
  const tool = parts[2];
  const threadId = parts[3];
  const selectedSessionId = interaction.values[0];

  if (action === 'attach') {
    try {
      await interaction.deferUpdate();
    } catch (e) {}
    const meta = getOrInferMetadata(interaction.channel);
    if (meta) {
      meta.sessionId = selectedSessionId;
      meta.hasStarted = true;
      saveMetadata();
    }
    
    try {
      const msg = await interaction.channel.messages.fetch(interaction.message.id);
      await msg.edit({
        content: `⏳ Spawning PTY terminal attached to session \`${selectedSessionId.substring(0, 8)}\`...`,
        components: []
      });
    } catch (e) {}

    await ptyManager.startSession({
      thread: interaction.channel,
      tool,
      directory: meta ? meta.directory : '/home/dev',
      sessionId: selectedSessionId
    });
  }
}

async function handleExportModalSubmit(interaction) {
  const parts = interaction.customId.split(':');
  const threadId = parts[1];
  const exportType = interaction.fields.getTextInputValue('export-type').trim().toLowerCase();
  const limitStr = interaction.fields.getTextInputValue('export-limit').trim();
  const limit = limitStr ? parseInt(limitStr, 10) : null;

  const meta = getOrInferMetadata(interaction.channel);
  if (!meta) {
    return interaction.reply({ content: '❌ Session metadata not found.', ephemeral: true });
  }

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (e) {
    return;
  }

  const { getDriver } = require('../drivers');
  const driver = getDriver(meta.tool);
  let exportPath = null;
  
  if (driver && typeof driver.exportSessionCustom === 'function') {
    exportPath = driver.exportSessionCustom(meta.sessionId || '', meta.directory, { type: exportType, limit: limit });
  } else if (driver && typeof driver.exportSession === 'function') {
    exportPath = driver.exportSession(meta.sessionId || '', meta.directory, { verbose: exportType === 'all' });
  }

  if (!exportPath) {
    exportPath = await exportTaskToTmpCustom(threadId, meta, { type: exportType, limit: limit });
  }

  if (exportPath && fs.existsSync(exportPath)) {
    try {
      await interaction.editReply({
        content: `📤 **Session Export Ready (${exportType.toUpperCase()}${limit ? `, last ${limit} turns` : ''}):**`,
        files: [exportPath]
      });
      fs.unlinkSync(exportPath);
    } catch (err) {
      console.error('Failed to send export file to Discord:', err);
      await interaction.editReply({ content: `❌ Failed to send export file: ${err.message}` });
    }
  } else {
    await interaction.editReply({ content: '❌ Failed to export session.' });
  }
}

async function exportTaskToTmpCustom(threadId, meta, { type = 'clean', limit = null }) {
  const fs = require('fs');
  const path = require('path');
  const exportFile = path.join('/tmp', `gateway-export-${meta.tool}-${threadId}.md`);
  
  try {
    const client = require('../utils/state').getClient();
    const thread = await client.channels.fetch(threadId);
    if (!thread) return null;
    const messages = await thread.messages.fetch({ limit: 100 });
    const sortedMessages = [...messages.values()].reverse();

    const turns = [];

    sortedMessages.forEach(msg => {
      const timeStr = msg.createdAt.toISOString();
      const author = msg.author.bot ? `🤖 **Bot (${msg.author.username})**` : `👤 **User (${msg.author.username})**`;
      
      let content = msg.content;
      
      if (type === 'clean' && msg.author.bot) {
        if (
          content.includes('🚀 **Starting agent session...**') ||
          content.includes('🔄 **Resuming conversation session...**') ||
          content.includes('✅ **Agent execution completed successfully!**') ||
          content.includes('exited ') ||
          content.includes('Command:') ||
          content.includes('Updated:') ||
          content.includes('Notice:') ||
          content.includes('Select a session to bind/attach') ||
          content.includes('Thread successfully bound/attached')
        ) {
          return;
        }
      }
      
      if (type === 'activity' && msg.author.bot) {
        const isActivity = content.includes('Edit File:') || content.includes('Description:') || content.includes('Instruction:') || content.includes('Tool Call:') || content.includes('Tool Output');
        if (!isActivity) return;
      }

      if (content.trim()) {
        turns.push({
          timeStr,
          author,
          content
        });
      }
    });

    let finalTurns = turns;
    if (limit && limit > 0 && turns.length > limit) {
      finalTurns = turns.slice(-limit);
    }

    let markdownContent = `# Discord Chat-Ops Session Export (Fallback)\n* **Tool:** ${(meta.tool === 'agy' ? 'antigravity' : meta.tool).toUpperCase()}\n* **Directory:** \`${meta.directory}\`\n* **Session ID:** \`${meta.sessionId || 'None'}\`\n* **Filter:** \`${type.toUpperCase()}\`\n* **Export Time:** ${new Date().toISOString()}\n\n---\n\n## Conversation Log\n\n`;

    finalTurns.forEach(turn => {
      markdownContent += `### [${turn.timeStr}] ${turn.author}\n${turn.content}\n\n`;
    });

    fs.writeFileSync(exportFile, markdownContent);
    return exportFile;
  } catch (err) {
    console.error('Fallback export failed:', err);
    return null;
  }
}

function getThreadControlRow(threadId, meta) {
  const { ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');
  const isRunning = processManager.activeTasks.has(threadId);

  const row1Buttons = [];
  if (isRunning) {
    row1Buttons.push(
      new ButtonBuilder()
        .setCustomId(`thread-control:stop:${threadId}`)
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('🛑')
    );
  }

  if (meta && meta.sessionId) {
    row1Buttons.push(
      new ButtonBuilder()
        .setCustomId(`thread-control:export-modal:${threadId}`)
        .setLabel('Export Session')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📤')
    );
  }

  row1Buttons.push(
    new ButtonBuilder()
      .setCustomId(`thread-control:toggle-detail:${threadId}`)
      .setLabel(meta && meta.hideExecDetails ? 'Show Actions' : 'Hide Actions')
      .setStyle(meta && meta.hideExecDetails ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji(meta && meta.hideExecDetails ? '👁️' : '⚡')
  );

  const row2Buttons = [
    new ButtonBuilder()
      .setCustomId(`thread-control:attach:${threadId}`)
      .setLabel(meta && meta.sessionId ? 'Change Session' : 'Attach Session')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🔗'),
    new ButtonBuilder()
      .setCustomId(`thread-control:change-model:${threadId}`)
      .setLabel('Change Model')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('🤖'),
    new ButtonBuilder()
      .setCustomId(`thread-control:delete-cli-session:${threadId}`)
      .setLabel('Delete Session')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🔥'),
    new ButtonBuilder()
      .setCustomId(`thread-control:delete:${threadId}`)
      .setLabel('Delete Thread')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️')
  ];

  const rows = [];
  rows.push(new ActionRowBuilder().addComponents(...row1Buttons));
  rows.push(new ActionRowBuilder().addComponents(...row2Buttons));
  return rows;
}

async function updateThreadControlMessage(channel, meta) {
  if (!channel || !channel.isThread()) return;
  try {
    const { getDriver } = require('../drivers');
    const driver = getDriver(meta.tool);
    if (meta.sessionId && driver && typeof driver.getSessionTitle === 'function') {
      const rawTitle = driver.getSessionTitle(meta.sessionId, meta.directory);
      if (rawTitle) {
        meta.sessionTitle = rawTitle.split('\n')[0].split('---')[0].trim();
      }
    }

    const messages = await channel.messages.fetch({ limit: 20 });
    const botControlMsg = messages.find(msg => 
      msg.author.id === channel.client.user.id && 
      msg.components.length > 0 && 
      (msg.content.startsWith('### 🤖') || msg.content.startsWith('### 📟'))
    );
    
    if (botControlMsg) {
      const updatedContent = updateMessageContent(botControlMsg.content, meta);
      const updatedRow = getThreadControlRow(channel.id, meta);
      await botControlMsg.edit({
        content: updatedContent,
        components: updatedRow
      });
    }
  } catch (err) {
    console.error('Failed to update thread control message:', err);
  }
}

function updateMessageContent(oldContent, meta) {
  let lines = oldContent.split('\n');
  lines = lines.filter(l => !l.includes('**Attached Session ID:**') && !l.includes('**Prompt:**') && !l.includes('**Detail Mode:**'));
  
  if (meta) {
    let insertIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith('* **')) {
        insertIndex = i + 1;
        break;
      }
    }
    
    const modeStr = meta.hideExecDetails ? 'Clean (Text Only)' : 'Verbose (Show Actions)';
    const detailLine = `* **Detail Mode:** \`${modeStr}\``;
    if (insertIndex !== -1) {
      lines.splice(insertIndex, 0, detailLine);
      insertIndex++; // Increment to preserve insertion order if adding next line
    } else {
      lines.push(detailLine);
    }

    if (meta.sessionId) {
      let sessionNameSuffix = '';
      if (meta.sessionTitle) {
        sessionNameSuffix = ` (${meta.sessionTitle})`;
      }
      const attachedLine = `* **Attached Session ID:** \`${meta.sessionId}\`${sessionNameSuffix}`;
      if (insertIndex !== -1) {
        lines.splice(insertIndex, 0, attachedLine);
      } else {
        lines.push(attachedLine);
      }
    }
  }
  return lines.join('\n');
}

module.exports = {
  handleChoiceButton,
  handleThreadButton,
  handleProjectButton,
  handleSessionButton,
  handleGatewayButton,
  handleProcessButton,
  handleThreadControlButton,
  handleThreadControlSelect,
  handlePtyCtrlButton,
  handlePtyCtrlSelect,
  getThreadControlRow,
  updateThreadControlMessage,
  handleExportModalSubmit,
};
