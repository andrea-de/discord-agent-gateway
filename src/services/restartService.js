const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { ChannelType } = require('discord.js');
const { currentGateway, getClient } = require('../utils/state');

async function performGitPullAndRestart(triggerSource) {
  const client = getClient();
  const GUILD_ID = process.env.GUILD_ID;
  let outputText = '';
  try {
    outputText = await new Promise((resolve) => {
      exec('git pull', { cwd: path.join(__dirname, '../..') }, (error, stdout, stderr) => {
        let out = '';
        if (error) {
          out += `❌ **Git Pull Error:** ${error.message}\n`;
        }
        if (stdout && stdout.trim()) {
          out += `stdout:\n\`\`\`\n${stdout.trim()}\n\`\`\`\n`;
        }
        if (stderr && stderr.trim()) {
          out += `stderr:\n\`\`\`\n${stderr.trim()}\n\`\`\`\n`;
        }
        if (!out) {
          out = 'Already up to date (no output).\n';
        }
        resolve(out);
      });
    });
  } catch (err) {
    outputText = `❌ Failed to perform git pull: ${err.message}\n`;
  }

  const statusMsg = `🔄 **Restarting Gateway [${currentGateway}]...**\n\n**Git Pull Output:**\n${outputText}`;
  console.log(statusMsg.replace(/\*+/g, ''));

  if (triggerSource && typeof triggerSource.editReply === 'function') {
    try {
      await triggerSource.editReply({ content: statusMsg });
    } catch (e) {}
  } else if (triggerSource && typeof triggerSource.send === 'function') {
    try {
      await triggerSource.send(statusMsg);
    } catch (e) {}
  } else {
    // If triggered via keyboard shortcut in terminal, send status to the gateway text channel
    try {
      const channelName = currentGateway.toLowerCase();
      if (GUILD_ID) {
        const guild = client.guilds.cache.get(GUILD_ID);
        if (guild) {
          const gatewayChannel = guild.channels.cache.find(c => c.name === channelName && c.type === ChannelType.GuildText);
          if (gatewayChannel) {
            await gatewayChannel.send(statusMsg);
          }
        }
      }
    } catch (e) {
      console.error('Failed to notify Discord of keyboard restart:', e.message);
    }
  }

  // Allow a short delay for Discord API messages to flush
  setTimeout(() => {
    let stdioOption = 'ignore';
    try {
      if (process.stdout.isTTY) {
        const ttyFd = fs.openSync('/dev/tty', 'r+');
        stdioOption = [ttyFd, ttyFd, ttyFd];
      }
    } catch (e) {
      console.warn('Could not open /dev/tty for restart redirection, defaulting to ignore:', e.message);
    }

    const child = spawn(process.argv[0], process.argv.slice(1), {
      detached: true,
      stdio: stdioOption
    });
    child.unref();
    process.exit(0);
  }, 1000);
}

module.exports = {
  performGitPullAndRestart,
};
