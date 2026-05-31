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

### 1. Starting a Task (`/antigravity` or `/codex`)
Instead of a generic `/agent` command, you run the slash command for the tool you want to invoke. This exposes optional parameters to configure the execution environment or pass custom flags directly.

* **Commands:**
  * `/antigravity`: Spawns a Google Antigravity CLI process.
  * `/codex`: Spawns an OpenAI Codex CLI process.
* **Options:**
  * `directory` (Required): Absolute path to a valid local directory.
  * `task` (Required): Prompt/instructions for the agent.
  * `mode` (Optional, defaults to `review`):
    * `review`: Pauses at breakpoints and renders action buttons.
    * `yolo`: Auto-approves permissions and executes autonomously.
  * `model` (Optional): Specify a custom LLM model (passed via env variables for `agy` or `-m` for `codex`).
  * `flags` (Optional): Specify arbitrary space-separated CLI arguments exactly as you would run them locally (e.g. `flags:--sandbox --print-timeout 10m` or `flags:--strict-config`).

---

### 2. Output Streaming & Interaction
When a task starts, the bot generates a dynamic Discord thread (named like `[antigravity] Fix canvas physics layout...`). Inside this thread:

* **Virtual Rolling Terminal:** Logs stream into code blocks. The bot edits the last log message sequentially up to the 2000-character limit before creating a new message block, preventing chat flood.
* **Component Buttons:** When an agent pauses to ask for approval or multiple-choice inputs, the bot blocks further execution and renders native Discord buttons mapped to choice values. Clicking a button injects the option cleanly into the agent's `stdin`.
* **Standard Replies (stdin):** If the agent asks for text guidance, users can type a standard reply in the thread. The bot catches it, appends `\n`, pipes it to the CLI `stdin`, and reacts with a `📥` emoji for verification.

---

### 3. Utility Slash Commands
* `/status`: Queries the active/completed process details (duration, log location, model configuration, and parsed token/subagent details).
* `/model [name]`: Gets or sets the LLM model for the thread. If a model name is provided, updates the thread configuration for subsequent resumption/continuation runs.
* `/usage`: Displays overall token usage for the current billing cycle, remaining quota balance, cycle reset date, and individual tool usage breakdown.
* `/export`: Saves a Markdown transcription of the thread history into your local project workspace.
* `/kill`: Terminates the running process (`SIGTERM` -> `SIGKILL`) and archives the thread.

---

## 🔒 Understanding & Troubleshooting the Sandbox

The agent tools run in isolated configurations to protect your host system:
* **Antigravity (`antigravity`)**: Employs app-level restrictions when running with `--sandbox`.
* **Codex (`codex`)**: Uses **Bubblewrap** (`bwrap`) on Linux to isolate shell commands. It creates a private mount namespace (making the project directory writable and everything else read-only) and a private network namespace (blocking external internet access).

### Error: `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`

This error occurs when Bubblewrap tries to initialize the local network loopback interface (`lo`) inside the restricted namespace. Newer versions of Ubuntu (24.04+), Debian, or nested container environments restrict unprivileged user namespaces from modifying network interfaces by default.

To resolve this issue:

#### Option A: Allow Bubblewrap specifically via AppArmor (Recommended)
You can permit Bubblewrap to use namespaces without disabling system-wide protections:
1. **Identify the correct path to `bwrap`**:
   The binary might be at `/usr/bin/bwrap` or bundled inside your global node modules. Run:
   ```bash
   which bwrap || find /usr -name bwrap 2>/dev/null
   ```
2. **Create/Edit the profile file**:
   ```bash
   sudo nano /etc/apparmor.d/bwrap
   ```
3. **Add the following content** (Ensure the path after `profile bwrap` matches the path found in step 1):
   ```text
   abi <abi/4.0>,
   include <tunables/global>

   profile bwrap /path/to/your/bwrap flags=(unconfined) {
     userns,
     include if exists <local/bwrap>
   }
   ```
4. **Reload AppArmor**:
   ```bash
   sudo systemctl reload apparmor
   ```

#### Option B: Temporary sysctl Workaround
Disable unprivileged user namespace restrictions system-wide (quickest way to test):
```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

#### Option C: Bypassing via Command Option
When executing a task via the Discord slash commands, select **`Danger: Full Access`** for `/codex`'s `sandbox` option, or do not enable the `sandbox` option for `/antigravity`. This disables Bubblewrap/sandboxing and runs commands directly on the host using your user permissions.

