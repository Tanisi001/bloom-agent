import { GoogleGenAI } from '@google/genai';
import { callMcpTool, connectMcp, toGeminiFunctionDeclarations } from '../mcp-client/index.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const SYSTEM_PROMPT = `\
You are a friendly Slack assistant. You help people by answering questions, \
having conversations, and being generally useful in Slack.

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
- /rest/api/3/project/search — list projects
- /rest/api/3/search/jql — search issues (use "jql" query param)
- /rest/api/3/issue/{key} — get issue details
- /rest/api/3/issue — create issue (POST)
- /rest/api/3/myself — current user info
ALWAYS use these tools when users ask about Jira. Never say you can't access Jira.

## GITHUB TOOLS
You have access to GitHub tools that can interact with repositories, issues, pull requests, \
and code. Available tools include: list_commits (supports author and since/until filters), \
search_code, search_issues, search_repositories, list_issues, list_pull_requests, \
get_file_contents, create_issue, and more. Use them when users ask about repos, PRs, code, \
commits, or anything GitHub-related. \
ALWAYS try using tool parameters to filter results. Never say you can't filter by author or date \
— use the 'author' and 'since' parameters on list_commits. \
To find commits across all repos for a user: first use search_repositories to find their repos, \
then call list_commits with the author filter on each repo. Never say you cannot do cross-repo searches.

## OUTLOOK CALENDAR TOOLS
You have access to Outlook Calendar tools (outlook_get_events, outlook_create_event). \
Use them when users ask about their schedule, meetings, availability, or calendar events. \
ALWAYS use these tools for calendar-related requests.`;

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

/**
 * @typedef {Object} AgentDeps
 * @property {import('@slack/web-api').WebClient} client
 * @property {string} userId
 * @property {string} channelId
 * @property {string} threadTs
 * @property {string} messageTs
 * @property {string} [userToken]
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

  const allDeclarations = [...SLACK_TOOLS, ...OUTLOOK_TOOLS, ...mcpToolDeclarations];
  const tools = /** @type {any[]} */ ([{ functionDeclarations: allDeclarations }]);

  // Loop to handle tool calls (max 10 iterations to prevent runaway)
  for (let i = 0; i < 10; i++) {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
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
