# 🌸 Bloom Agent

A privacy-preserving AI-powered Slack agent that detects burnout risk patterns at the team level. Bloom analyzes messaging patterns, sentiment shifts, and workload signals to surface team wellness insights — without monitoring individuals.

## What Bloom Does

Bloom connects to your team's Slack workspace and uses AI to identify burnout risk signals:

- **After-hours messaging** — Detects increased late-night/weekend activity
- **Sentiment analysis** — Identifies shifts in team communication tone
- **Meeting overload** — Tracks calendar density and scheduling patterns
- **Escalation frequency** — Monitors spikes in urgent requests

**Example output:**
> "Engineering Team A shows a 63% increase in overload indicators this month."

## Integrations

Bloom connects to multiple tools via MCP (Model Context Protocol) and function calling:

| Integration | Method | Capabilities |
|-------------|--------|------|
| **Slack** | Slack Web API (function calling) | Read channels, search messages, send messages, sentiment analysis |
| **Jira** | MCP (`@aashari/mcp-server-atlassian-jira`) | Track issues, workload, sprint health |
| **GitHub** | MCP (`@modelcontextprotocol/server-github`) | Monitor commits, PRs, code review load |
| **Outlook Calendar** | Microsoft Graph API (function calling) | Detect meeting overload, scheduling patterns |

## How to Interact

- **Direct Messages** — DM the agent to ask about team wellness, channel sentiment, or workload
- **Channel @mentions** — Mention the agent in any channel for contextual analysis
- **Assistant Panel** — Use Slack's assistant panel for guided prompts

## Setup

### Prerequisites

- Node.js 18+
- [Slack CLI](https://docs.slack.dev/tools/slack-cli/guides/installing-the-slack-cli-for-mac-and-linux/)
- A Slack workspace with permissions to install apps

### 1. Install dependencies

```sh
npm install
```

### 2. Configure environment

Rename `.env.sample` to `.env` and fill in your credentials:

```sh
# Required
GEMINI_API_KEY=your_gemini_api_key

# Optional - Jira MCP
ATLASSIAN_SITE_NAME=your-company
ATLASSIAN_USER_EMAIL=your.email@company.com
ATLASSIAN_API_TOKEN=your_api_token

# Optional - GitHub MCP
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_your_token

# Optional - Outlook Calendar
MS_GRAPH_TOKEN=your_microsoft_graph_token
```

### 3. Run the app

```sh
slack run
```

## Project Structure

```
├── agent/              # Gemini AI agent with function calling tools
│   ├── agent.js        # Core agent logic, system prompt, tool definitions
│   └── index.js        # Exports
├── mcp-client/         # MCP client infrastructure
│   └── index.js        # Multi-server MCP client (Jira, GitHub)
├── listeners/          # Slack event handlers
│   ├── events/         # Message, mention, app home events
│   ├── actions/        # Feedback button handlers
│   └── views/          # Block Kit view builders
├── thread-context/     # Conversation history store
├── tests/              # Unit tests
├── app.js              # Entry point (socket mode)
└── manifest.json       # Slack app configuration
```

## Architecture

```
User (Slack) → Bolt Event Listener → Gemini AI (function calling)
                                          ↓
                              ┌───────────┼───────────┐
                              ↓           ↓           ↓
                        Slack Tools   MCP Client   Outlook API
                        (Web API)    (Jira/GitHub)  (Graph API)
```

The agent uses Gemini's function calling to dynamically select and invoke tools. MCP servers are connected at startup via stdio transport, with tools automatically discovered and bridged to Gemini function declarations.

## Linting & Testing

```sh
npm run lint        # Check code style
npm run lint:fix    # Auto-fix issues
npm test            # Run unit tests
```

## 🏆 About

This app was developed as part of [Codegeist 2025](https://devpost.com/software/copycat-la20vz).

## 👥 Contributors

<a href="https://github.com/Manoranjanmaharana1">
  <img src="https://github.com/Manoranjanmaharana1.png" width="50" height="50" alt="Manoranjanmaharana1" />
</a>
<a href="https://github.com/Tanisi001">
  <img src="https://github.com/Tanisi001.png" width="50" height="50" alt="Tanisi001" />
</a>
