const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('agy')
    .setDescription('Initiates an Antigravity task in a new thread')
    .addStringOption(option =>
      option.setName('task')
        .setDescription('Explain the task or prompt for the agent to execute')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('directory')
        .setDescription('Absolute path or project folder name')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('gateway')
        .setDescription('Target gateway location (e.g. HELSINKI, NUREMBERG)')
        .setRequired(false)
        .addChoices(
          { name: 'Helsinki', value: 'HELSINKI' },
          { name: 'Nuremberg', value: 'NUREMBERG' }
        )
    )
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('Execution mode (default: review)')
        .setRequired(false)
        .addChoices(
          { name: 'Review Mode (default)', value: 'review' },
          { name: 'YOLO Mode (auto-approve)', value: 'yolo' }
        )
    )
    .addStringOption(option =>
      option.setName('model')
        .setDescription('Specify LLM model name (e.g. gemini-2.5-pro)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('flags')
        .setDescription('Custom command-line flags (e.g. --sandbox)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('codex')
    .setDescription('Initiates a Codex task in a new thread')
    .addStringOption(option =>
      option.setName('task')
        .setDescription('Explain the task or prompt for the agent to execute')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('directory')
        .setDescription('Absolute path or project folder name')
        .setRequired(false)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName('gateway')
        .setDescription('Target gateway location (e.g. HELSINKI, NUREMBERG)')
        .setRequired(false)
        .addChoices(
          { name: 'Helsinki', value: 'HELSINKI' },
          { name: 'Nuremberg', value: 'NUREMBERG' }
        )
    )
    .addStringOption(option =>
      option.setName('mode')
        .setDescription('Execution mode (default: review)')
        .setRequired(false)
        .addChoices(
          { name: 'Review Mode (default)', value: 'review' },
          { name: 'YOLO Mode (auto-approve)', value: 'yolo' }
        )
    )
    .addStringOption(option =>
      option.setName('model')
        .setDescription('Specify LLM model name (e.g. o3-mini)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('flags')
        .setDescription('Custom command-line flags (e.g. --strict-config)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Queries status of the active agent task in this thread'),

  new SlashCommandBuilder()
    .setName('usage')
    .setDescription('Displays overall token usage and remaining quota for this billing cycle'),

  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Gets or sets the LLM model for subsequent tasks in this thread')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Specify LLM model name (e.g. gpt-4o, o3-mini)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Exports this thread session log to a markdown file in the project directory'),

  new SlashCommandBuilder()
    .setName('kill')
    .setDescription('Forcefully terminates the active agent task and archives this thread')
];

/**
 * Registers application slash commands with the Discord API.
 */
async function registerCommands(token, clientId, guildId) {
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    console.log(`Started refreshing ${commands.length} application (/) commands...`);

    let data;
    if (guildId) {
      // Local Guild-specific registration (instant updates, highly recommended for development)
      data = await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log(`Successfully reloaded ${data.length} guild (/) commands.`);
    } else {
      // Global registration (can take up to an hour to propagate)
      data = await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log(`Successfully reloaded ${data.length} global (/) commands.`);
    }
    return true;
  } catch (error) {
    console.error('Error registering slash commands:', error);
    return false;
  }
}

module.exports = {
  commands,
  registerCommands
};
