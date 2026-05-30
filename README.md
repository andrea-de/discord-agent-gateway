# Discord Chat-Ops Developer Gateway

A local Discord "Chat-Ops" developer gateway to spin up, monitor, and interact with agentic CLI tools (Google Antigravity CLI `agy` and OpenAI Codex CLI `codex`) via Discord Forum Channels or dynamic public threads. 

Instead of emulating a raw terminal interface, the gateway wraps executions into readable markdown logs and translates agent checkpoints (like permission requests or tool choices) into interactive Discord component buttons.

---

## 📂 Project Structure

```text
discord-agentic/
├── src/
│   ├── gateway.js          # Main entrypoint, handles Discord event listeners & client routers
│   ├── processManager.js   # Spawns CLI sub-processes, manages inputs/outputs & log buffering
│   ├── parser.js           # Sanitizes logs & detects interactive prompts/choices
│   └── commands.js         # Defines and registers Discord Slash Commands
├── .env.example            # Configuration template for Discord bot authorization keys
├── package.json            # Node project configuration & dependencies (discord.js, dotenv)
└── README.md               # Setup & deployment guide
```

---

## 🛠️ Step 1: Provisioning Discord Bot Tokens

To run this gateway on your local machine, you need to create and authorize a Discord bot:

1. **Go to the Discord Developer Portal:**
   * Open the [Discord Developer Portal](https://discord.com/developers/applications).
   * Click **New Application** in the top right, name it (e.g., `Local Agent Gateway`), and click **Create**.

2. **Generate Bot Token:**
   * Go to the **Bot** tab on the left sidebar.
   * Click **Reset Token** and copy the generated token. This will be your `DISCORD_TOKEN`.
   * Enable the following **Privileged Gateway Intents** (scroll down to the "Privileged Gateway Intents" section):
     * **Presence Intent**
     * **Server Members Intent**
     * **Message Content Intent** (Crucial for receiving terminal replies in threads).
   * Save changes.

3. **Get Client ID:**
   * Go to the **OAuth2** tab.
   * Copy the **Client ID** listed under General Information. This will be your `CLIENT_ID`.

4. **Invite the Bot to your Guild/Server:**
   * Go to the **OAuth2** -> **URL Generator** tab.
   * Under **Scopes**, check `bot` and `applications.commands`.
   * Under **Bot Permissions**, check:
     * `Send Messages`
     * `Send Messages in Threads`
     * `Create Public Threads`
     * `Create Private Threads`
     * `Read Message History`
     * `Add Reactions`
     * `Manage Threads`
   * Copy the generated URL at the bottom and open it in a browser to authorize the bot on your target Discord server (Guild).

5. **Get Guild ID:**
   * Enable **Developer Mode** in Discord (User Settings -> Advanced -> Developer Mode).
   * Right-click your server's name in Discord and select **Copy Server ID**. This will be your `GUILD_ID`.

---

## 🚀 Step 2: Installation & Configuration

1. **Clone/Navigate to this folder:**
   ```bash
   cd /home/andy/Projects/discord-agentic
   ```

2. **Install Node.js dependencies:**
   *(Ensure you have Node.js 18+ installed. You currently have Node.js v22.18.0)*
   ```bash
   npm install
   ```

3. **Configure Environment Variables:**
   * Copy the example configuration:
     ```bash
     cp .env.example .env
     ```
   * Open `.env` and fill in the values you copied in Step 1:
     ```ini
     DISCORD_TOKEN=your_copied_bot_token
     CLIENT_ID=your_copied_client_id
     GUILD_ID=your_copied_guild_id
     ```

---

## ⚙️ Step 3: Running the Gateway

Start the gateway server in development mode:
```bash
node src/gateway.js
```
The console will log command registration status and print a message once online:
```text
🤖 Logged in as Local Agent Gateway#1234!
Started refreshing 4 application (/) commands...
Successfully reloaded 4 guild (/) commands.
Gateway is ready to receive tasks.
```

---

## 📖 Command Guide & Interaction Flow

### 1. Starting a Task (`/agent`)
Run the `/agent` command in any Discord channel (works inside Forum channels or standard Text channels).

* **Syntax:**
  ```text
  /agent tool:[agy|codex] directory:[path/to/project] task:[your prompt] mode:[review|yolo]
  ```
* **Parameters:**
  * `tool`: Select `agy` (Antigravity CLI) or `codex` (Codex CLI).
  * `directory`: Absolute path to a valid local directory (must contain a `.git` folder).
  * `task`: Instructions or prompt for the agent (e.g. `Fix canvas physics layout issue`).
  * `mode` (Optional, defaults to `review`):
    * `review`: Default. Gateway listens to `stdout`, intercepts agent checkpoints/prompts, and formats interactive button panels.
    * `yolo`: Runs the agents with auto-approve configurations (`--dangerously-skip-permissions` for `agy` and `--ask-for-approval never` for `codex`). Streams outputs continuously, only stopping on crash or task completion.

---

### 2. Output Streaming & Interaction
When a task starts, the bot generates a dynamic Discord thread (named like `[agy] Fix canvas physics layout...`). Inside this thread:

* **Virtual Rolling Terminal:** Logs stream into code blocks. The bot edits the last log message sequentially up to the 2000-character limit before creating a new message block, preventing chat flood.
* **Component Buttons:** When an agent pauses to ask for approval or multiple-choice inputs, the bot blocks further execution and renders native Discord buttons mapped to choice values. Clicking a button injects the option cleanly into the agent's `stdin`.
* **Standard Replies (stdin):** If the agent asks for text guidance, users can type a standard reply in the thread. The bot catches it, appends `\n`, pipes it to the CLI `stdin`, and reacts with a `📥` emoji for verification.

---

### 3. Utility Slash Commands (Inside Active Threads)
* `/status`: Displays elapsed execution time, model quota metrics, active subagents, and memory log locations parsed from active task logs.
* `/export`: Fetches the entire Discord thread message history and saves a clean Markdown report (`gateway-export-[tool]-[threadId].md`) in your local project workspace.
* `/kill`: Immediately kills the CLI subprocess (`SIGTERM` -> `SIGKILL`), flushes final logs, logs completion details, and archives/locks the Discord thread.
