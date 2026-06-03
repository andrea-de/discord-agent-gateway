const fs = require('fs');
const path = require('path');
const { ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const processManager = require('../processManager');
const ptyManager = require('../ptyManager');
const { currentGateway, threadMetadata, saveMetadata } = require('../utils/state');
const { resolveGatewayAndProject, resolveProjectDirectory, getOrCreateProjectChannel } = require('../services/projectService');
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

      threadMetadata.set(thread.id, { tool, directory: resolvedDirectory, mode, model, flags, sandbox, hasStarted: true });
      saveMetadata();
    } else {
      await interaction.editReply({
        content: `✅ Interactive session thread created successfully in <#${targetChannel.id}>! Follow progress in: <#${thread.id}>`
      });

      await thread.send('⌨️ **Gateway Awaiting First Prompt**\nPlease type your first task or question directly in this thread to initiate the agent process.');

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
          const files = fs.readdirSync(resolvedDir)
            .filter(f => f.startsWith(`.gateway-${meta.tool}-`) && f.endsWith('.log'));

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
    saveMetadata();
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

    await thread.send(`### 📟 Persistent PTY Session Initiated
* **Tool:** \`${tool.toUpperCase()}\`
* **Directory:** \`${resolvedDirectory}\`
* **Type:** \`INTERACTIVE PTY\`
---
*Note: Any message sent in this thread will be piped directly to the terminal's stdin as keystrokes.*`);

    if (permissionWarning) {
      const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=105226685456&scope=bot%20applications.commands`;
      await thread.send(`⚠️ **Notice:** ${permissionWarning} Thread fell back to the current channel (<#${interaction.channel.id}>). To enable auto-channel creation for new projects under an **${categoryName}** category, please grant the bot the **Manage Channels** permission, or [click here to re-authorize the bot](${inviteUrl}).`);
    }

    await ptyManager.startSession({
      thread,
      tool,
      directory: resolvedDirectory
    });

    threadMetadata.set(thread.id, { 
      tool, 
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
}

async function handleUsageCommand(interaction) {
  try {
    await interaction.deferReply();
  } catch (err) {
    console.warn('Failed to defer reply for usage command:', err.message);
    return;
  }

  const USAGE_FILE = path.join(__dirname, '../../.usage-registry.json');
  const threadId = interaction.channelId;
  const meta = threadMetadata.get(threadId);

  let threadTokens = 0;
  let globalTokens = 0;
  let toolTotals = { agy: 0, codex: 0, gemini: 0 };
  let threadTotalsMap = new Map();
  let threadModelTotals = new Map();

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
    const { getDriver } = require('../drivers');
    try {
      const driver = getDriver(meta.tool);
      const usageCard = driver.getProviderUsageInfo(threadTokens, meta.model, threadModelTotals);
      return interaction.editReply(usageCard);
    } catch (err) {
      return interaction.editReply(`❌ **Failed to retrieve provider usage details:** ${err.message}`);
    }
  } else {
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

  const embed = new EmbedBuilder()
    .setTitle(`📁 Project Dashboard: ${inferredProject}`)
    .setDescription(`Use the buttons below to interactively fetch information about this project. Responses are sent **ephemerally** to prevent channel clutter.`)
    .setColor('#2b2d31')
    .addFields(
      { name: 'Gateway', value: `\`${gateway || 'Default'}\``, inline: true },
      { name: 'Directory', value: `\`${resolvedDirectory}\``, inline: true }
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
      .setEmoji('🌿')
  );

  return interaction.reply({ embeds: [embed], components: [row1, row2] });
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
};
