const fs = require('fs');
const path = require('path');
const { ChannelType } = require('discord.js');
const { isTargetForInteraction } = require('../services/projectService');
const { currentGateway } = require('../utils/state');

// Command handlers
const commandHandlers = require('./commandHandlers');
// Button handlers
const buttonHandlers = require('./buttonHandlers');
// Modal handlers
const modalHandlers = require('./modalHandlers');

async function handleInteraction(interaction) {
  const typeDisplay = interaction.isChatInputCommand() ? `Command (/${interaction.commandName})` :
                      interaction.isButton() ? `Button (${interaction.customId})` :
                      interaction.isModalSubmit() ? `Modal (${interaction.customId})` : `Type ${interaction.type}`;
  const channelName = interaction.channel ? interaction.channel.name : 'Unknown';
  console.log(`[Interaction] Received ${typeDisplay} in channel #${channelName}`);

  const isTarget = isTargetForInteraction(interaction);
  console.log(`[Interaction] Target check: ${isTarget ? 'MATCH (Handling)' : 'MISMATCH (Ignoring)'}`);

  if (!isTarget) {
    return; // Ignore if this instance is not the target
  }

  // 1. Chat input commands
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    if (commandName === 'antigravity' || commandName === 'codex' || commandName === 'gemini') {
      await commandHandlers.handleAgentCommand(interaction);
    } else if (commandName === 'status') {
      await commandHandlers.handleStatusCommand(interaction);
    } else if (commandName === 'usage') {
      await commandHandlers.handleUsageCommand(interaction);
    } else if (commandName === 'terminal') {
      await commandHandlers.handleTerminalCommand(interaction);
    } else if (commandName === 'sessions') {
      await commandHandlers.handleSessionsCommand(interaction);
    } else if (commandName === 'model') {
      await commandHandlers.handleModelCommand(interaction);
    } else if (commandName === 'permission') {
      await commandHandlers.handlePermissionCommand(interaction);
    } else if (commandName === 'export') {
      await commandHandlers.handleExportCommand(interaction);
    } else if (commandName === 'rename') {
      await commandHandlers.handleRenameCommand(interaction);
    } else if (commandName === 'delete') {
      await commandHandlers.handleDeleteCommand(interaction);
    } else if (commandName === 'kill') {
      await commandHandlers.handleKillCommand(interaction);
    } else if (commandName === 'stop') {
      await commandHandlers.handleStopCommand(interaction);
    } else if (commandName === 'archive-thread') {
      await commandHandlers.handleArchiveThreadCommand(interaction);
    } else if (commandName === 'info') {
      await commandHandlers.handleInfoCommand(interaction);
    } else if (commandName === 'restart') {
      await commandHandlers.handleRestartCommand(interaction);
    }
  }

  // 2. Buttons
  else if (interaction.isButton()) {
    const customId = interaction.customId;
    if (customId.startsWith('choice:')) {
      await buttonHandlers.handleChoiceButton(interaction);
    } else if (customId.startsWith('gateway-project:')) {
      await buttonHandlers.handleProjectButton(interaction);
    } else if (customId.startsWith('thread:')) {
      await buttonHandlers.handleThreadButton(interaction);
    } else if (customId.startsWith('session:')) {
      await buttonHandlers.handleSessionButton(interaction);
    } else if (customId.startsWith('gateway:')) {
      await buttonHandlers.handleGatewayButton(interaction);
    } else if (customId.startsWith('process:')) {
      await buttonHandlers.handleProcessButton(interaction);
    } else if (customId.startsWith('thread-control:')) {
      await buttonHandlers.handleThreadControlButton(interaction);
    } else if (customId.startsWith('pty-ctrl:')) {
      await buttonHandlers.handlePtyCtrlButton(interaction);
    }
  }

  // 3. String Select Menu
  else if (interaction.isStringSelectMenu()) {
    const customId = interaction.customId;
    if (customId.startsWith('thread-control-select:')) {
      await buttonHandlers.handleThreadControlSelect(interaction);
    } else if (customId.startsWith('pty-ctrl-select:')) {
      await buttonHandlers.handlePtyCtrlSelect(interaction);
    }
  }

  // 4. Modal Submissions
  else if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('session-modal:')) {
      await modalHandlers.handleSessionModal(interaction);
    } else if (interaction.customId.startsWith('export-modal:')) {
      await buttonHandlers.handleExportModalSubmit(interaction);
    }
  }

  // 4. Autocomplete
  else if (interaction.isAutocomplete()) {
    const { commandName } = interaction;
    if (commandName === 'antigravity' || commandName === 'codex' || commandName === 'gemini' || commandName === 'terminal') {
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
  }
}

module.exports = {
  handleInteraction,
};
