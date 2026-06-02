const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const CODEX_MODEL_CHOICES = [
  { name: 'GPT-5.2 Codex', value: 'gpt-5.2-codex' },
  { name: 'GPT-5.1 Codex Max', value: 'gpt-5.1-codex-max' },
  { name: 'GPT-5.1 Codex', value: 'gpt-5.1-codex' },
  { name: 'GPT-5 Codex', value: 'gpt-5-codex' },
  { name: 'GPT-5.2', value: 'gpt-5.2' },
  { name: 'GPT-5.1', value: 'gpt-5.1' },
  { name: 'GPT-5', value: 'gpt-5' },
  { name: 'GPT-5 mini', value: 'gpt-5-mini' },
  { name: 'GPT-5 nano', value: 'gpt-5-nano' },
  { name: 'GPT-4.1', value: 'gpt-4.1' },
  { name: 'GPT-4.1 mini', value: 'gpt-4.1-mini' },
  { name: 'o4-mini', value: 'o4-mini' }
];

const commands = [
  new SlashCommandBuilder()
    .setName('antigravity')
    .setDescription('Initiates an Antigravity task in a new thread')
    .addStringOption(option =>
      option.setName('task')
        .setDescription('Explain the task or prompt for the agent to execute')
        .setRequired(false)
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
          { name: 'XPS', value: 'XPS' },
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
    )
    .addBooleanOption(option =>
      option.setName('sandbox')
        .setDescription('Enable terminal restriction sandboxing for Antigravity')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('gemini')
    .setDescription('Initiates a Gemini CLI task in a new thread')
    .addStringOption(option =>
      option.setName('task')
        .setDescription('Explain the task or prompt for the agent to execute')
        .setRequired(false)
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
          { name: 'XPS', value: 'XPS' },
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
        .setDescription('Specify LLM model name (e.g. gemini-2.0-flash-exp)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('flags')
        .setDescription('Custom command-line flags')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('codex')
    .setDescription('Initiates a Codex task in a new thread')
    .addStringOption(option =>
      option.setName('task')
        .setDescription('Explain the task or prompt for the agent to execute')
        .setRequired(false)
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
          { name: 'XPS', value: 'XPS' },
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
        .addChoices(...CODEX_MODEL_CHOICES)
    )
    .addStringOption(option =>
      option.setName('flags')
        .setDescription('Custom command-line flags')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('sandbox')
        .setDescription('Sandbox policy for shell commands (default: workspace-write)')
        .setRequired(false)
        .addChoices(
          { name: 'Workspace Write (default)', value: 'workspace-write' },
          { name: 'Read Only', value: 'read-only' },
          { name: 'Danger: Full Access', value: 'danger-full-access' }
        )
    ),

  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Queries status of the active agent task in this thread'),

  new SlashCommandBuilder()
    .setName('info')
    .setDescription('Displays information and interactive dashboard for the current project text channel'),

  new SlashCommandBuilder()
    .setName('usage')
    .setDescription('Displays overall token usage and remaining quota for this billing cycle'),

  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Gets or sets the LLM model for subsequent tasks in this thread')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Select the Codex model for future runs in this thread')
        .setRequired(false)
        .addChoices(
          { name: 'Default', value: '__default__' },
          ...CODEX_MODEL_CHOICES
        )
    ),

  new SlashCommandBuilder()
    .setName('permission')
    .setDescription('Gets or sets the execution permission/sandbox policy for subsequent tasks in this thread')
    .addStringOption(option =>
      option.setName('policy')
        .setDescription('Specify permission policy or approval mode')
        .setRequired(false)
        .addChoices(
          { name: 'Default (Prompt for all)', value: 'default' },
          { name: 'Auto-Edit (Gemini: auto-approve edits)', value: 'auto_edit' },
          { name: 'Plan (Gemini: read-only mode)', value: 'plan' },
          { name: 'YOLO (Auto-approve everything)', value: 'yolo' },
          { name: 'Workspace Write (Codex)', value: 'workspace-write' },
          { name: 'Read Only (Codex)', value: 'read-only' },
          { name: 'Danger: Full Access (Codex)', value: 'danger-full-access' },
          { name: 'True (Antigravity Sandbox)', value: 'true' },
          { name: 'False (Antigravity Sandbox)', value: 'false' }
        )
    ),

  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Renames the current thread and optionally the agent session history')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('The new name for the thread')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Deletes the current thread and cleans up session metadata'),

  new SlashCommandBuilder()
    .setName('sessions')
    .setDescription('Lists all active and historical agent sessions for this gateway'),

  new SlashCommandBuilder()
    .setName('export')
    .setDescription('Exports this thread session log to a markdown file in the project directory'),

  new SlashCommandBuilder()
    .setName('kill')
    .setDescription('Forcefully terminates the active agent task and archives this thread'),

  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Pulls git updates and restarts the gateway server')
    .addStringOption(option =>
      option.setName('gateway')
        .setDescription('Target gateway location (e.g. HELSINKI, NUREMBERG, XPS)')
        .setRequired(false)
        .addChoices(
          { name: 'XPS', value: 'XPS' },
          { name: 'Helsinki', value: 'HELSINKI' },
          { name: 'Nuremberg', value: 'NUREMBERG' }
        )
    )
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
