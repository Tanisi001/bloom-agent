import { GoogleGenAI } from '@google/genai';
import { callMcpTool, connectMcp, toGeminiFunctionDeclarations } from '../mcp-client/index.js';
import { getTeamConfig, updateTeamConfig, updateUserData } from '../services/firebase.js';
import { generateTeamReport } from '../services/team-report.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `\
You are Bloom \u{1F331} \u2014 a friendly Slack assistant and wellness buddy. You help people by answering questions, \
having conversations, managing their tools, and taking care of their wellbeing.

## PERSONALITY
- Friendly, helpful, and approachable
- Lightly witty — a touch of humor when appropriate, but never forced
- Concise and clear — respect people's time
- Confident but honest when you don't know something

## RESPONSE GUIDELINES
- Keep responses to 3 sentences max for simple questions — be punchy, scannable, and actionable
- For analysis tasks (sentiment, summaries, reviews), provide thorough, detailed responses
- End with a clear next step on its own line so it's easy to spot
- Use a bullet list only for multi-step instructions
- Use casual, conversational language
- Use emoji sparingly — at most one per message, and only to set tone

## ANALYSIS CAPABILITIES
You are fully capable of performing sentiment analysis, mood assessment, workload analysis, \
and any other text analysis using YOUR OWN reasoning — no special tool is needed. \
When you have message content (from read_channel or search_messages), analyze it directly. \
Provide honest, detailed assessments about tone, morale, stress levels, and team dynamics. \
Categorize messages by sentiment, identify patterns, and give actionable insights. \
NEVER say you cannot do analysis or that you lack a tool for it — you ARE the analysis tool.

## FORMATTING RULES
- Use standard Markdown syntax: **bold**, _italic_, \`code\`, \`\`\`code blocks\`\`\`, > blockquotes
- Use bullet points for multi-step instructions

## EMOJI REACTIONS
Always call add_emoji_reaction before responding to acknowledge the user's message. \
Pick any Slack emoji that reflects the *topic* or *tone* — be creative and specific. \
Skip the reaction ~15% of the time to feel more natural.

## SLACK TOOLS
You have access to Slack tools for searching messages, reading channels/threads, \
sending messages, and managing canvases. Use them whenever they would help the user.

## JIRA TOOLS
You have access to Jira tools (jira_get, jira_post, jira_put, jira_patch, jira_delete) \
that can call any Jira REST API endpoint. Use them when users ask about projects, issues, \
sprints, or anything Jira-related. Common paths:
- /rest/api/3/project/search — list ALL projects (use this FIRST when unsure of project key)
- /rest/api/3/search/jql — search issues (use "jql" query param)
- /rest/api/3/issue/{key} — get issue details
- /rest/api/3/issue — create issue (POST)
- /rest/api/3/myself — current user info

CRITICAL JIRA BEHAVIOR:
- When a user mentions a project name (like "hackathon"), ALWAYS call /rest/api/3/project/search \
FIRST to discover the actual project key. Project names and keys are often different \
(e.g., name "My Hackathon" might have key "KAN" or "HACK").
- If a JQL search returns empty/null, try listing all projects to find the right key, \
then retry with the correct key.
- NEVER give up after one failed search. Always try /rest/api/3/project/search as a fallback.
- To list ALL issues across all projects: use JQL "order by created DESC" with no project filter.
ALWAYS use these tools when users ask about Jira. Never say you can't access Jira.

IMPORTANT: When searching for a team member's Jira activity: \
1. Use bloom_get_team_members to get their email addresses. \
2. ALWAYS use email in JQL assignee queries: assignee="user@email.com" \
3. NEVER search by display name — Jira requires email or account ID for assignee searches. \
4. For team-wide searches, iterate through each member's email.

## GITHUB TOOLS
You have access to GitHub tools that can interact with repositories, issues, pull requests, \
and code. Available tools include: list_commits (supports author and since/until filters), \
search_code, search_issues, search_repositories, list_issues, list_pull_requests, \
get_file_contents, create_issue, and more. Use them when users ask about repos, PRs, code, \
commits, or anything GitHub-related. \
ALWAYS try using tool parameters to filter results. Never say you can't filter by author or date \
— use the 'author' and 'since' parameters on list_commits. \
To find commits across all repos for a user: first use search_repositories to find their repos, \
then call list_commits with the author filter on each repo. Never say you cannot do cross-repo searches. \
\
IMPORTANT: When looking up a team member's GitHub activity: \
1. Use bloom_get_team_members to get their email addresses. \
2. Use the email as the author filter in list_commits (GitHub commits are linked to email). \
3. NEVER say you cannot find a user — always use their email to search. \
4. For team lookups, iterate through each member's email individually.

## OUTLOOK CALENDAR TOOLS
You have access to Outlook Calendar tools (outlook_get_events, outlook_create_event). \
Use them when users ask about their schedule, meetings, availability, or calendar events. \
ALWAYS use these tools for calendar-related requests.

## BLOOM WELLNESS FEATURES
You are also a team wellness buddy. Key capabilities:

### CONFIGURATION (SDM/Installer only)
When asked to configure/set up a team channel:
1. Call bloom_update_config with channel_id or channel_name.
2. Extract channel from <#C07ABC|name> format or resolve by name.
3. Optionally set team working hours (e.g. "9am to 6pm" -> start:9, end:18).

### ON-DEMAND SENTIMENT (Anyone can ask)
When asked "what's the mood?", "team sentiment", "how's the team?":
1. Call bloom_generate_sentiment. It reads the channel and returns a rich report.

### WORKING HOURS (Any user)
When a user says "my hours are X to Y":
1. Call bloom_set_working_hours with parsed hours.

### OPT IN/OUT (Any user)
When someone says "opt out" or "opt in":
1. Call bloom_opt_status.

### GITHUB USERNAME
When a user provides their GitHub username (e.g. "my github is octocat", "octocat", "github: octocat", \
or any short reply that looks like a username right after being asked):
1. Call bloom_set_github with the username.
2. Confirm it was saved.

### PRIVACY RULES (CRITICAL)
- NEVER reveal individual drain scores, active minutes, or nudge history.
- Team mood reports analyze PUBLIC channel messages only.
- Show how individuals FEEL (from public messages) but NOT private metrics.
- SDM sees team mood + individual feelings. NOT hours worked or drain data.`;

/** Tool declarations for Gemini function calling */
const SLACK_TOOLS = [
  {
    name: 'add_emoji_reaction',
    description:
      "Add an emoji reaction to the user's current message. Use any standard Slack emoji matching the topic/tone.",
    parameters: {
      type: 'object',
      properties: {
        emoji_name: { type: 'string', description: "Slack emoji name without colons (e.g. 'tada', 'wave')" },
      },
      required: ['emoji_name'],
    },
  },
  {
    name: 'search_messages',
    description: 'Search Slack messages and files. Returns matching messages with channel/user context.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string (supports Slack search modifiers like from:, in:, has:, before:, after:)',
        },
        count: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_channel',
    description: 'Read recent message history from a Slack channel.',
    parameters: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The Slack channel ID (e.g. C01ABCDEF) or channel name (e.g. random, #general)',
        },
        limit: { type: 'number', description: 'Number of messages to retrieve (default 10, max 100)' },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'read_thread',
    description: 'Read all replies in a Slack thread.',
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The channel ID containing the thread' },
        thread_ts: { type: 'string', description: 'The timestamp of the parent message' },
      },
      required: ['channel_id', 'thread_ts'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a message to a Slack channel or thread.',
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'The channel ID to send the message to' },
        text: { type: 'string', description: 'The message text to send' },
        thread_ts: { type: 'string', description: 'Optional thread timestamp to reply in a thread' },
      },
      required: ['channel_id', 'text'],
    },
  },
  {
    name: 'search_channels',
    description: 'Search for Slack channels by name.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Channel name or partial name to search for' },
      },
      required: ['query'],
    },
  },
];

/** Outlook Calendar tool declarations */
const OUTLOOK_TOOLS = process.env.MS_GRAPH_TOKEN
  ? [
      {
        name: 'outlook_get_events',
        description:
          'Get calendar events from Outlook/Microsoft 365. Returns upcoming events by default, or events in a date range.',
        parameters: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: 'Start date in ISO 8601 format (e.g. 2026-06-28T00:00:00Z). Defaults to now.' },
            end_date: { type: 'string', description: 'End date in ISO 8601 format. Defaults to 7 days from start.' },
            top: { type: 'number', description: 'Max events to return (default 10)' },
          },
          required: [],
        },
      },
      {
        name: 'outlook_create_event',
        description: 'Create a new calendar event in Outlook/Microsoft 365.',
        parameters: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: 'Event title/subject' },
            start: { type: 'string', description: 'Start time in ISO 8601 format (e.g. 2026-07-01T10:00:00)' },
            end: { type: 'string', description: 'End time in ISO 8601 format' },
            body: { type: 'string', description: 'Event description (optional)' },
            location: { type: 'string', description: 'Event location (optional)' },
          },
          required: ['subject', 'start', 'end'],
        },
      },
    ]
  : [];

/** Bloom wellness tool declarations */
const BLOOM_TOOLS = [
  {
    name: 'bloom_update_config',
    description: 'Configure team channel and working hours for Bloom wellness tracking.',
    parameters: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Slack channel ID.' },
        channel_name: { type: 'string', description: 'Channel name to resolve.' },
        working_hours_start: { type: 'number', description: 'Team default start hour (0-23).' },
        working_hours_end: { type: 'number', description: 'Team default end hour (0-23).' },
      },
    },
  },
  {
    name: 'bloom_generate_sentiment',
    description: 'Generate an on-demand team mood/sentiment report by analyzing the configured channel.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'bloom_set_working_hours',
    description: "Set the current user's personal working hours for wellness nudge timing.",
    parameters: {
      type: 'object',
      properties: {
        start_hour: { type: 'number', description: 'Start hour (0-23).' },
        end_hour: { type: 'number', description: 'End hour (0-23).' },
      },
      required: ['start_hour', 'end_hour'],
    },
  },
  {
    name: 'bloom_opt_status',
    description: 'Opt in or out of Bloom wellness tracking for the current user.',
    parameters: {
      type: 'object',
      properties: { opted_out: { type: 'boolean', description: 'true=opt out, false=opt in' } },
      required: ['opted_out'],
    },
  },
  {
    name: 'bloom_get_team_members',
    description: 'Get all registered team members with their emails and names. Use this to look up GitHub/Jira activity by email or name.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'bloom_set_github',
    description: "Save the current user's GitHub username. Called when user says 'my github is X' or provides their username.",
    parameters: {
      type: 'object',
      properties: { github_username: { type: 'string', description: 'GitHub username (e.g. octocat)' } },
      required: ['github_username'],
    },
  },
];

/**
 * @typedef {Object} AgentDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
 * @property {string} [teamId]
 * @property {string} [originalText]
 */

/**
 * Execute a tool call and return the result.
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {AgentDeps} [deps]
 * @returns {Promise<string>}
 */
async function executeTool(name, args, deps) {
  if (!deps) return 'No Slack access available.';

  try {
    switch (name) {
      case 'add_emoji_reaction': {
        if (Math.random() < 0.15) return 'Skipped reaction (random omit).';
        await deps.client.reactions.add({
          channel: deps.channelId,
          timestamp: deps.messageTs,
          name: args.emoji_name,
        });
        return `Reacted with :${args.emoji_name}:`;
      }
      case 'search_messages': {
        const result = await deps.client.search.messages({
          token: deps.userToken,
          query: args.query,
          count: args.count || 5,
        });
        const matches = result.messages?.matches || [];
        if (!matches.length) return 'No messages found.';
        return matches.map((m) => `[${m.channel?.name || 'unknown'}] ${m.username}: ${m.text}`).join('\n');
      }
      case 'read_channel': {
        let channelId = args.channel_id;
        // Resolve channel name to ID if it doesn't look like an ID
        if (!channelId.match(/^[A-Z0-9]+$/)) {
          const name = channelId.replace(/^#/, '').toLowerCase();
          const list = await deps.client.conversations.list({ limit: 200, types: 'public_channel' });
          const found = (list.channels || []).find((c) => c.name === name);
          if (!found) return `Channel "${channelId}" not found.`;
          channelId = /** @type {string} */ (found.id);
        }
        // Auto-join public channels so the bot can read them
        try {
          await deps.client.conversations.join({ channel: channelId });
        } catch (_) {
          // Ignore if already a member or can't join
        }
        const result = await deps.client.conversations.history({
          channel: channelId,
          limit: args.limit || 10,
        });
        const msgs = result.messages || [];
        return msgs.map((m) => `[${m.ts}] ${m.user || 'bot'}: ${m.text}`).join('\n') || 'No messages.';
      }
      case 'read_thread': {
        const result = await deps.client.conversations.replies({
          channel: args.channel_id,
          ts: args.thread_ts,
        });
        const msgs = result.messages || [];
        return msgs.map((m) => `${m.user || 'bot'}: ${m.text}`).join('\n') || 'No replies.';
      }
      case 'send_message': {
        await deps.client.chat.postMessage({
          channel: args.channel_id,
          text: args.text,
          ...(args.thread_ts && { thread_ts: args.thread_ts }),
        });
        return 'Message sent.';
      }
      case 'search_channels': {
        const result = await deps.client.conversations.list({ limit: 100, types: 'public_channel' });
        const channels = (result.channels || []).filter((c) => c.name?.includes(args.query.toLowerCase()));
        if (!channels.length) return 'No channels found.';
        return channels.map((c) => `#${c.name} (${c.id}): ${c.purpose?.value || ''}`).join('\n');
      }
      default:
        // Try Bloom wellness tools
        if (name.startsWith('bloom_')) {
          return await executeBloomTool(name, args, deps);
        }
        // Try Outlook tools
        if (name === 'outlook_get_events' && process.env.MS_GRAPH_TOKEN) {
          const now = new Date();
          const start = args.start_date || now.toISOString();
          const end = args.end_date || new Date(now.getTime() + 7 * 86400000).toISOString();
          const top = args.top || 10;
          const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=${top}&$select=subject,start,end,location,organizer`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.MS_GRAPH_TOKEN}` } });
          const data = await res.json();
          if (data.error) return `Error: ${data.error.message}`;
          const events = data.value || [];
          if (!events.length) return 'No events found in that time range.';
          return events.map((e) => `• ${e.subject} | ${e.start?.dateTime} - ${e.end?.dateTime} | ${e.location?.displayName || ''}`).join('\n');
        }
        if (name === 'outlook_create_event' && process.env.MS_GRAPH_TOKEN) {
          const body = {
            subject: args.subject,
            start: { dateTime: args.start, timeZone: 'UTC' },
            end: { dateTime: args.end, timeZone: 'UTC' },
            ...(args.body && { body: { contentType: 'text', content: args.body } }),
            ...(args.location && { location: { displayName: args.location } }),
          };
          const res = await fetch('https://graph.microsoft.com/v1.0/me/events', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.MS_GRAPH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (data.error) return `Error: ${data.error.message}`;
          return `Event created: "${data.subject}" on ${data.start?.dateTime}`;
        }
        // Try MCP tools
        console.log(`[Agent] mcpToolNames has ${mcpToolNames.size} entries:`, [...mcpToolNames]);
        if (mcpToolNames.has(name)) {
          return await callMcpTool(name, args);
        }
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${/** @type {any} */ (e).message || e}`;
  }
}

/** @type {Array<{name: string, description: string, parameters: Record<string, any>}>} */
let mcpToolDeclarations = [];

/** @type {Set<string>} */
let mcpToolNames = new Set();

/** @type {boolean} */
let mcpInitialized = false;

/**
 * Initialize the MCP client and load tools. Call once at startup.
 * Fails silently if MCP env vars are not set.
 */
export async function initMcpTools() {
  if (!process.env.ATLASSIAN_SITE_NAME) return;
  if (mcpInitialized) return;
  try {
    const tools = await connectMcp();
    mcpToolDeclarations = toGeminiFunctionDeclarations(tools);
    mcpToolNames = new Set(tools.map((t) => t.name));
    mcpInitialized = true;
    console.log(`[MCP] Connected. ${tools.length} Jira tools available: ${[...mcpToolNames].join(', ')}`);
  } catch (e) {
    console.warn(`[MCP] Failed to connect: ${/** @type {any} */ (e).message}`);
  }
}

/**
 * Run the agent with the given text and conversation history.
 * @param {string} text - The user's message text.
 * @param {Array<{role: string, parts: Array<any>}>} [history] - Previous conversation turns.
 * @param {AgentDeps} [deps] - Dependencies for tools that need Slack API access.
 * @returns {Promise<{responseText: string, history: Array<{role: string, parts: Array<any>}>}>}
 */
export async function runAgent(text, history = [], deps = undefined) {
  // Ensure MCP tools are loaded
  if (!mcpInitialized) await initMcpTools();

  const contents = [...history, { role: 'user', parts: [{ text }] }];

  const allDeclarations = [...SLACK_TOOLS, ...BLOOM_TOOLS, ...OUTLOOK_TOOLS, ...mcpToolDeclarations];
  const tools = /** @type {any[]} */ ([{ functionDeclarations: allDeclarations }]);

  // Loop to handle tool calls (max 10 iterations to prevent runaway)
  for (let i = 0; i < 10; i++) {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      config: { systemInstruction: SYSTEM_PROMPT, tools },
      contents,
    });

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    console.log(`[Agent] Iteration ${i + 1}, parts:`, JSON.stringify(parts.map((p) => p.functionCall ? { fn: p.functionCall.name } : { text: (p.text || '').slice(0, 50) })));

    // Check if model wants to call functions
    const functionCalls = parts.filter((p) => p.functionCall);

    if (functionCalls.length === 0) {
      // No tool calls — extract text response
      const responseText = parts.map((p) => p.text || '').join('');
      contents.push({ role: 'model', parts });
      return { responseText, history: contents };
    }

    // Execute tool calls and add results
    contents.push({ role: 'model', parts });

    const functionResponses = [];
    for (const part of functionCalls) {
      const fc = /** @type {{name: string, args: Record<string, any>}} */ (part.functionCall);
      console.log(`[Agent] Calling tool: ${fc.name}`, JSON.stringify(fc.args));
      const result = await executeTool(fc.name, fc.args || {}, deps);
      console.log(`[Agent] Tool result (first 200 chars):`, result.slice(0, 200));
      functionResponses.push({ functionResponse: { name: fc.name, response: { result } } });
    }

    contents.push({ role: 'user', parts: functionResponses });
  }

  // Fallback if we hit max iterations
  return { responseText: "I'm having trouble completing that request. Could you try rephrasing?", history: contents };
}

// ======================== BLOOM TOOL EXECUTION ========================

/**
 * Execute Bloom wellness tool calls.
 * @param {string} name
 * @param {Record<string, any>} args
 * @param {AgentDeps} [deps]
 * @returns {Promise<string>}
 */
async function executeBloomTool(name, args, deps) {
  const teamId = deps?.teamId || 'default';

  switch (name) {
    case 'bloom_update_config': {
      const config = await getTeamConfig(teamId);

      // Resolve channel ID
      let channelId = args.channel_id || null;
      if (!channelId && deps?.originalText) {
        const match = deps.originalText.match(/<#(C[A-Z0-9]+)\|?[^>]*>/i);
        if (match) channelId = match[1];
      }
      if (!channelId && args.channel_name && deps?.client) {
        try {
          const searchName = args.channel_name.replace(/^#/, '').toLowerCase().trim();
          let cursor = undefined;
          let found = null;
          do {
            const listRes = await deps.client.conversations.list({ types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor });
            found = (listRes.channels || []).find((ch) => ch.name.toLowerCase() === searchName);
            if (found) break;
            cursor = listRes.response_metadata?.next_cursor;
          } while (cursor);
          if (found) channelId = found.id;
        } catch (e) { console.log(`[bloom] Channel lookup error: ${e.message}`); }
      }

      const updates = {};
      if (channelId) updates.channelId = channelId;
      if (args.channel_name) updates.channelName = args.channel_name;
      if (args.working_hours_start !== undefined) updates.workingHoursStart = args.working_hours_start;
      if (args.working_hours_end !== undefined) updates.workingHoursEnd = args.working_hours_end;
      await updateTeamConfig(teamId, updates);

      if (channelId && channelId !== config.channelId && global.onConfigureComplete) {
        global.onConfigureComplete(teamId, channelId);
      }

      const merged = { ...config, ...updates };
      return `Config updated. Channel: ${merged.channelId || 'not set'}, hours: ${merged.workingHoursStart || 9}-${merged.workingHoursEnd || 17}`;
    }

    case 'bloom_generate_sentiment': {
      if (!deps?.client) return 'No Slack client available.';
      const report = await generateTeamReport(deps.client, teamId);
      if (!report) return 'No messages found to analyze. Ensure a channel is configured and has recent activity.';
      try {
        await deps.client.chat.postMessage({ channel: deps.channelId, thread_ts: deps.threadTs, ...report });
        return 'Sentiment report generated and posted.';
      } catch (e) {
        return `Report generated but failed to post: ${e.message}`;
      }
    }

    case 'bloom_set_working_hours': {
      if (!deps?.userId) return 'No user context.';
      await updateUserData(teamId, deps.userId, { workingHoursStart: args.start_hour, workingHoursEnd: args.end_hour });
      return `Working hours set to ${args.start_hour}:00 - ${args.end_hour}:00.`;
    }

    case 'bloom_opt_status': {
      if (!deps?.userId) return 'No user context.';
      await updateUserData(teamId, deps.userId, { optedOut: args.opted_out });
      if (!args.opted_out && global.startWellnessCron) global.startWellnessCron();
      return args.opted_out ? 'Opted out of wellness tracking.' : 'Opted in to wellness tracking.';
    }

    case 'bloom_get_team_members': {
      const { getAllUsers } = await import('../services/firebase.js');
      const users = await getAllUsers(teamId);
      if (!users || Object.keys(users).length === 0) return 'No team members registered yet.';
      const members = Object.entries(users).map(([id, u]) => `${u.name || id} (email: ${u.email || 'unknown'}, github: ${u.githubUsername || 'not set'}, slack: <@${id}>)`);
      return `Team members:\n${members.join('\n')}`;
    }

    case 'bloom_set_github': {
      if (!deps?.userId) return 'No user context.';
      await updateUserData(teamId, deps.userId, { githubUsername: args.github_username });
      return `GitHub username saved: ${args.github_username}. I'll use this to track your contributions.`;
    }

    default:
      return `Unknown bloom tool: ${name}`;
  }
}
