const fs = require('fs');
const path = require('path');
const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const processManager = require('../processManager');
const ptyManager = require('../ptyManager');
const { currentGateway, threadMetadata, saveMetadata } = require('../utils/state');
const { resolveGatewayAndProject, resolveProjectDirectory, getOrCreateProjectChannel, getDashboardComponents, updateProjectDashboard, sendProjectDashboard } = require('../services/projectService');
const { performGitPullAndRestart } = require('../services/restartService');
const { updateSessionsList } = require('../services/statusUiService');
const { CUSTOM_IDS } = require('../utils/constants');


const CLIENT_ID = process.env.CLIENT_ID;

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

  const channel = interaction.channel;
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildForum)) {
    return interaction.editReply({
      content: '❌ Agent execution can only be initiated inside a standard Text Channel or a Forum Channel.'
    });
  }

  const chosenGateway = interaction.options.getString('gateway');
  const { gateway: inferredGateway, project: inferredProject } = resolveGatewayAndProject(channel);

  if (channel.name.toLowerCase() === currentGateway.toLowerCase() && !channel.parentId) {
    if (chosenGateway && chosenGateway.toUpperCase() !== currentGateway) {
      return interaction.editReply({
        content: `❌ **Invalid Gateway:** Inside the status channel <#${channel.id}>, the gateway is locked to **${currentGateway}**. You cannot target a different gateway here.`
      });
    }
  }

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

  const { targetChannel: projectChannel, permissionWarning } = await getOrCreateProjectChannel(guild, resolvedDirectory);
  const targetChannel = projectChannel || channel;
  const categoryName = `${currentGateway} GATEWAY`;

  try {
    const hasPrompt = !!(taskPrompt && taskPrompt.trim());
    const name = hasPrompt
      ? `[${tool}] ${taskPrompt.trim().substring(0, 75)}`.trim()
      : `[${tool}] Interactive Session`;
    let thread;

    thread = await targetChannel.threads.create({
      name,
      autoArchiveDuration: 1440,
      reason: `Agent Gateway Start`
    });

    const promptDisplay = hasPrompt ? taskPrompt : '*Awaiting first prompt in thread...*';
    const sandboxDisplay = tool === 'codex'
      ? (sandbox || (mode === 'yolo' ? 'danger-full-access' : 'workspace-write'))
      : (sandbox !== undefined && sandbox !== null ? sandbox : 'Default');
    const displayToolName = tool === 'agy' ? 'antigravity' : tool;
    const meta = { tool, directory: resolvedDirectory, mode, model, flags, sandbox, hasStarted: hasPrompt, hideExecDetails: true };
    threadMetadata.set(thread.id, meta);
    saveMetadata();

    const { getThreadControlRow } = require('./buttonHandlers');
    const controlRow = getThreadControlRow(thread.id, meta);

    await thread.send({
      content: `### 🤖 ${hasPrompt ? 'Task' : 'Interactive Session'} Initiated\n* **Tool:** \`${displayToolName.toUpperCase()}\`\n* **Directory:** \`${resolvedDirectory}\`\n* **Mode:** \`${mode.toUpperCase()}\`\n* **Model:** \`${model || 'Default'}\`\n* **Sandbox Policy:** \`${sandboxDisplay}\`${flags ? `\n* **Flags:** \`${flags}\`` : ''}`,
      components: controlRow
    });

    if (permissionWarning) {
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=105226685456&scope=bot%20applications.commands`;
      await thread.send(`⚠️ **Notice:** ${permissionWarning} Thread fell back to the current channel (<#${channel.id}>). To enable auto-channel creation for new projects under an **${categoryName}** category, please grant the bot the **Manage Channels** permission, or [click here to re-authorize the bot](${inviteUrl}).`);
    }

    if (hasPrompt) {
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

      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode, model, flags, sandbox, hasStarted: true, hideExecDetails: true });
      saveMetadata();
    } else {
      await interaction.editReply({
        content: `✅ Interactive session thread created successfully in <#${targetChannel.id}>! Follow progress in: <#${thread.id}>`
      });

      await thread.send('⌨️ **Gateway Awaiting First Prompt**\nPlease type your first task or question directly in this thread to initiate the agent process.');

      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode, model, flags, sandbox, hasStarted: false, hideExecDetails: true });
      saveMetadata();
    }

  } catch (error) {
    console.error('Error starting agent task:', error);
    await interaction.editReply({
      content: `❌ **Failed to start task:** ${error.message}`
    });
  }
}

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
        
        const quotaMatch = logs.match(/cost|quota|price|charge.*\$([\d\.]+)/i) || logs.match(/([\$0-9\.]+)\s*(?:credits|dollars)/i);
        if (quotaMatch) {
          quotaInfo = quotaMatch[0];
        }
        
        const tokenMatch = logs.match(/tokens used\s*\n\s*([\d,]+)/i) || logs.match(/(\d+)\s*(?:total\s*)?tokens/i) || logs.match(/tokens?:\s*(\d+)/i);
        if (tokenMatch) {
          tokenInfo = `${parseInt(tokenMatch[1].replace(/,/g, ''), 10).toLocaleString()} tokens`;
        }

        const subagentMatch = logs.match(/(?:spawned|active)\s*(?:subagent|agent)\s*["']?([a-zA-Z0-9_-]+)["']?/i) || logs.match(/subagent\s+(\w+)/i);
        if (subagentMatch) {
          subagentInfo = subagentMatch[0];
        }
      }
    } catch (e) {
      console.error('Error reading log for metrics:', e);
    }
  } else {
    tool = (meta.tool === 'agy' ? 'antigravity' : meta.tool).toUpperCase();
    status = meta.hasStarted === false ? 'AWAITING FIRST PROMPT' : 'IDLE (Completed)';
    directory = meta.directory;
    mode = meta.mode.toUpperCase();
    modelStr = meta.model || 'Default';
    sandboxVal = meta.sandbox !== undefined && meta.sandbox !== null ? String(meta.sandbox) : 'Default';

    if (meta.hasStarted !== false) {
      try {
        const os = require('os');
        let resolvedDir = directory;
        if (directory.startsWith('~')) {
          resolvedDir = path.join(os.homedir(), directory.substring(1));
        }

        if (fs.existsSync(resolvedDir) && fs.statSync(resolvedDir).isDirectory()) {
          let files = fs.readdirSync(resolvedDir)
            .filter(f => f.startsWith(`.gateway-${meta.tool}-${threadId}-`) && f.endsWith('.log'));
          if (files.length === 0) {
            files = fs.readdirSync(resolvedDir)
              .filter(f => f.startsWith(`.gateway-${meta.tool}-`) && f.endsWith('.log'));
          }

          if (files.length > 0) {
            files.sort((a, b) => b.localeCompare(a));
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
    await channel.setName(newName);
    meta.threadName = newName;
    
    if (meta.sessionId) {
      const { getDriver } = require('../drivers');
      const driver = getDriver(meta.tool);
      if (driver && typeof driver.renameSession === 'function') {
        driver.renameSession(meta.sessionId, newName);
      }
    }
    
    saveMetadata();
    
    // Update control panel message to reflect the new name in the header
    const { updateThreadControlMessage } = require('./buttonHandlers');
    await updateThreadControlMessage(channel, meta);
    
    await interaction.editReply(`✅ **Thread renamed successfully to:** \`${newName}\``);
  } catch (err) {
    console.error('Rename failed:', err);
    await interaction.editReply(`❌ **Failed to rename thread:** ${err.message}`);
  }
}

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

async function handleKillCommand(interaction) {
  const threadId = interaction.channelId;
  const task = processManager.activeTasks.get(threadId);
  const ptySession = ptyManager.activeSessions.get(threadId);

  if (!task && !ptySession) {
    return interaction.reply({
      content: '❌ No active agent task or terminal session found in this thread.',
      ephemeral: true
    });
  }

  await interaction.reply('🛑 **Forcefully terminating active shell process...**');
  
  let success = false;
  if (task) {
    success = await processManager.killTask(threadId);
  } else if (ptySession) {
    success = await ptyManager.killSession(threadId);
  }

  if (!success) {
    await interaction.followUp({
      content: '❌ Failed to terminate process.',
      ephemeral: true
    });
  }
}

async function handleRestartCommand(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.warn('Failed to defer reply for restart command:', err.message);
  }
  await performGitPullAndRestart(interaction);
}

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
    const currentModel = meta.model || 'Default';
    let response = `🤖 **Current thread model configuration:** \`${currentModel}\``;
    
    if (task) {
      response += `\n* **Active running process model:** \`${task.model || 'Default'}\``;
    }
    
    return interaction.reply(response);
  }
}

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

  if (newPolicy !== null && newPolicy !== undefined) {
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

async function handleSessionsCommand(interaction) {
  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.warn('Failed to defer reply for sessions command:', err.message);
    return;
  }
  await updateSessionsList(interaction);
}

async function handleTerminalCommand(interaction) {
  const tool = (interaction.options.getString('tool') || 'bash').toLowerCase();
  const directory = interaction.options.getString('directory');

  try {
    await interaction.deferReply({ ephemeral: true });
  } catch (err) {
    console.warn('Failed to defer reply for terminal command:', err.message);
    return;
  }

  const { gateway, project: inferredProject } = resolveGatewayAndProject(interaction.channel);

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

  if (!resolvedDirectory) {
    return interaction.editReply({
      content: '❌ **Directory required:** Please specify the \`directory\` option or run the command from a project-specific channel.'
    });
  }

  const { targetChannel: projectChannel, permissionWarning } = await getOrCreateProjectChannel(interaction.guild, resolvedDirectory);
  const targetChannel = projectChannel || interaction.channel;
  const categoryName = `${currentGateway} GATEWAY`;

  try {
    const threadName = `📟 [PTY] ${tool.toUpperCase()} in ${resolvedDirectory.split('/').pop()}`;
    const thread = await targetChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      reason: 'Interactive PTY Start'
    });

    threadMetadata.set(thread.id, { 
      tool, 
      directory: resolvedDirectory, 
      isPty: true,
      hasStarted: false,
      hideExecDetails: true
    });
    saveMetadata();

    if (tool === 'bash') {
      await thread.send(`### 📟 Persistent PTY Session Initiated
* **Tool:** \`BASH\`
* **Directory:** \`${resolvedDirectory}\`
* **Type:** \`INTERACTIVE PTY\`
---
*Note: Any message sent in this thread will be piped directly to the terminal's stdin as keystrokes.*`);

      await ptyManager.startSession({
        thread,
        tool,
        directory: resolvedDirectory
      });
      
      const meta = threadMetadata.get(thread.id);
      if (meta) {
        meta.hasStarted = true;
        saveMetadata();
      }
    } else {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pty-ctrl:new:${tool}:${thread.id}`)
          .setLabel('Start New PTY')
          .setStyle(ButtonStyle.Success)
          .setEmoji('🆕'),
        new ButtonBuilder()
          .setCustomId(`pty-ctrl:attach:${tool}:${thread.id}`)
          .setLabel('Attach to Session')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔗')
      );

      await thread.send({
        content: `### 📟 Persistent PTY Session Configuration
* **Tool:** \`${tool.toUpperCase()}\`
* **Directory:** \`${resolvedDirectory}\`
* **Type:** \`INTERACTIVE PTY\`
---
Please select how you would like to initiate this PTY session:`,
        components: [row]
      });
    }

    if (permissionWarning) {
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=105226685456&scope=bot%20applications.commands`;
      await thread.send(`⚠️ **Notice:** ${permissionWarning} Thread fell back to the current channel (<#${interaction.channel.id}>). To enable auto-channel creation for new projects under an **${categoryName}** category, please grant the bot the **Manage Channels** permission, or [click here to re-authorize the bot](${inviteUrl}).`);
    }

    await interaction.editReply({ content: `✅ Terminal session thread created in <#${thread.id}>` });
  } catch (err) {
    console.error('PTY task start failed:', err);
    await interaction.editReply({ content: `❌ Failed to start terminal: ${err.message}` });
  }
}

async function handleUsageCommand(interaction) {
  try {
    await interaction.deferReply();
  } catch (err) {
    console.warn('Failed to defer reply for usage command:', err.message);
    return;
  }

  const threadId = interaction.channelId;
  const meta = threadMetadata.get(threadId);

  if (!meta) {
    // If not in a registered thread, just query and show general live quotas
    try {
      const quotaService = require('../utils/quotaService');
      const liveQuotaReport = await quotaService.getLiveQuotaReport();
      return interaction.editReply(liveQuotaReport);
    } catch (err) {
      return interaction.editReply(`❌ **Failed to retrieve live Google API quotas:** ${err.message}`);
    }
  }

  let usageCard = `## 📊 Live Usage & Quota Report\n* **Tool:** \`${(meta.tool === 'agy' ? 'antigravity' : meta.tool).toUpperCase()}\`\n`;

  try {
    const quotaService = require('../utils/quotaService');
    
    if (meta.tool === 'gemini') {
      const geminiToken = await quotaService.getGeminiToken();
      const geminiProj = quotaService.getGeminiProjectId();
      const geminiData = await quotaService.getQuotaDetails(geminiToken, geminiProj);
      
      usageCard += `\n### ♊ Live API Quotas (Project-based: \`${geminiProj}\`)\n`;
      if (geminiToken && geminiData) {
        usageCard += quotaService.formatQuotaMarkdown(geminiData, "Gemini", geminiProj);
      } else {
        usageCard += `*Credentials unavailable or failed to connect to Google API.*`;
      }
    } else if (meta.tool === 'agy') {
      const agyToken = await quotaService.getAntigravityToken();
      const agyData = await quotaService.getQuotaDetails(agyToken, "");
      
      usageCard += `\n### 🪐 Live API Quotas (Consumer-based)\n`;
      if (agyToken && agyData) {
        usageCard += quotaService.formatQuotaMarkdown(agyData, "Antigravity", "");
      } else {
        usageCard += `*Credentials unavailable or failed to connect to Google API.*`;
      }
    } else {
      usageCard += `\n*Live quota checks are not supported/configured for the \`${meta.tool}\` tool.*`;
    }

    return interaction.editReply(usageCard);
  } catch (err) {
    return interaction.editReply(`❌ **Failed to retrieve live API quotas:** ${err.message}`);
  }
}

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

  const resolvedDirectory = resolveProjectDirectory(inferredProject);

  if (!resolvedDirectory) {
    return interaction.reply({
      content: `❌ Could not resolve the local project directory for project: \`${inferredProject}\`.`,
      ephemeral: true
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const updated = await updateProjectDashboard(channel);
    if (updated) {
      await interaction.editReply({ content: '📊 **Project dashboard updated with active sessions!**' });
    } else {
      // Re-create the project dashboard if it wasn't found
      await sendProjectDashboard(channel, resolvedDirectory);
      await interaction.editReply({ content: '📊 **Project dashboard recreated and updated with active sessions!**' });
    }
  } catch (err) {
    console.error('Failed to handle /info command:', err);
    await interaction.editReply({ content: `❌ **Failed to update dashboard:** ${err.message}` });
  }
}

async function handleStopCommand(interaction) {
  const threadId = interaction.channelId;
  const task = processManager.activeTasks.get(threadId);

  if (!task) {
    return interaction.reply({
      content: '❌ No active agent task found in this thread.',
      ephemeral: true
    });
  }

  await interaction.reply({ content: '🛑 **Stopping active headless agent execution...**' });

  const success = await processManager.killTask(threadId, { archiveThread: false });
  if (!success) {
    await interaction.followUp({
      content: '❌ Failed to stop agent execution.',
      ephemeral: true
    });
  }
}

async function handleArchiveThreadCommand(interaction) {
  const threadId = interaction.channelId;
  const task = processManager.activeTasks.get(threadId);
  const ptySession = ptyManager.activeSessions.get(threadId);

  if (!task && !ptySession) {
    return interaction.reply({
      content: '❌ No active agent task or terminal session found in this thread.',
      ephemeral: true
    });
  }

  await interaction.reply('🛑 **Terminating active processes and archiving thread...**');

  let success = false;
  if (task) {
    success = await processManager.killTask(threadId, { archiveThread: true });
  } else if (ptySession) {
    // For PTY interactive terminals
    success = await ptyManager.killSession(threadId);
    if (success) {
      try {
        const thread = interaction.channel;
        if (thread && thread.isThread()) {
          await thread.edit({ archived: true, locked: true });
        }
      } catch (err) {
        console.error('Failed to archive PTY thread:', err);
      }
    }
  }

  if (!success) {
    await interaction.followUp({
      content: '❌ Failed to terminate process or archive thread.',
      ephemeral: true
    });
  }
}

module.exports = {
  handleAgentCommand,
  handleStatusCommand,
  handleRenameCommand,
  handleDeleteCommand,
  handleExportCommand,
  handleKillCommand,
  handleRestartCommand,
  handleModelCommand,
  handlePermissionCommand,
  handleSessionsCommand,
  handleTerminalCommand,
  handleUsageCommand,
  handleInfoCommand,
  handleStopCommand,
  handleArchiveThreadCommand,
};
