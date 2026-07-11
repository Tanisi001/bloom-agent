/**
 * Team Report Module — On-demand, multi-source.
 *
 * Includes: channel sentiment + per-user activity stats (Slack, GitHub, Jira).
 * SDM sees individual feelings (from public messages) + activity hours.
 * Does NOT expose drain scores or nudge history.
 */

import { GoogleGenAI } from '@google/genai';
import { getTeamConfig, getAllUsers } from './firebase.js';
import { getUserActivitySummary } from './activity-tracker.js';
import { callMcpTool } from '../mcp-client/index.js';

/**
 * Generate a rich team mood report with Block Kit.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} teamId
 * @returns {Promise<{text: string, blocks: object[]} | null>}
 */
export async function generateTeamReport(client, teamId) {
  const config = await getTeamConfig(teamId);
  if (!config.channelId) return null;

  // Fetch channel messages
  const oldest = Math.floor(Date.now() / 1000) - (config.lookbackHours || 24) * 3600;
  let result = await client.conversations.history({ channel: config.channelId, oldest: oldest.toString(), limit: 200 });
  let messages = (result.messages || []).filter((m) => !m.bot_id && !m.subtype && m.text);

  if (messages.length === 0) {
    const olderTs = Math.floor(Date.now() / 1000) - 720 * 3600;
    result = await client.conversations.history({ channel: config.channelId, oldest: olderTs.toString(), limit: 200 });
    messages = (result.messages || []).filter((m) => !m.bot_id && !m.subtype && m.text);
  }

  if (messages.length === 0) return null;

  // Get all users and their activity summaries
  const users = await getAllUsers(teamId);
  const userActivities = {};

  for (const [userId, userData] of Object.entries(users || {})) {
    if (userData.optedOut) continue;
    try {
      const mcpTools = {
        callMcpTool,
        githubUsername: userData.githubUsername || null,
        jiraEmail: userData.email || null,
      };
      userActivities[userId] = await getUserActivitySummary(teamId, userId, mcpTools);
    } catch (e) {
      console.warn(`[team-report] Activity fetch failed for ${userId}: ${e.message}`);
      userActivities[userId] = { activeMinutes: userData.activeMinutes || 0, github: { commits: 0 }, jira: { ticketUpdates: 0 } };
    }
  }

  // Build activity context string for Gemini
  const activityContext = Object.entries(userActivities)
    .map(([id, a]) => {
      const u = users[id];
      const name = u?.name || id.slice(0, 8);
      return `${name}: active ${a.activeMinutes}min, GitHub ${a.github.commits} commits, Jira ${a.jira.ticketUpdates} tickets`;
    })
    .join('\n');

  // Per-user message counts
  const userMsgCounts = {};
  for (const msg of messages) {
    userMsgCounts[msg.user] = (userMsgCounts[msg.user] || 0) + 1;
  }

  const topUsers = Object.entries(userMsgCounts).sort(([, a], [, b]) => b - a).slice(0, 8);
  const formatted = messages.slice(0, 60).map((m) => `<@${m.user}>: ${m.text}`).join('\n');

  // Get Gemini analysis
  const analysis = await analyzeWithGemini(formatted, activityContext, messages.length);

  // Build Block Kit response
  const blocks = [];

  blocks.push({ type: 'header', text: { type: 'plain_text', text: 'Team Mood & Activity Report' } });
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: analysis } });
  blocks.push({ type: 'divider' });

  // Bar chart — message activity
  if (topUsers.length > 0) {
    blocks.push({
      type: 'data_visualization',
      title: 'Message Activity',
      chart: {
        type: 'bar',
        series: [{
          name: 'Messages',
          data: topUsers.map(([userId, count]) => ({
            label: getUserLabel(userId, users),
            value: count,
          })),
        }],
        axis_config: {
          categories: topUsers.map(([userId]) => getUserLabel(userId, users)),
          x_label: 'Team Member',
          y_label: 'Messages',
        },
      },
    });
  }

  blocks.push({ type: 'divider' });

  // Activity stats table (active hours + GitHub + Jira)
  const activityRows = Object.entries(userActivities)
    .sort(([, a], [, b]) => b.activeMinutes - a.activeMinutes)
    .slice(0, 8);

  if (activityRows.length > 0) {
    blocks.push({
      type: 'table',
      column_settings: [
        { is_wrapped: true },
        { align: 'center' },
        { align: 'center' },
        { align: 'center' },
      ],
      rows: [
        [
          { type: 'raw_text', text: 'Member' },
          { type: 'raw_text', text: 'Active (hrs)' },
          { type: 'raw_text', text: 'Commits' },
          { type: 'raw_text', text: 'Tickets' },
        ],
        ...activityRows.map(([userId, a]) => [
          { type: 'raw_text', text: users[userId]?.name || userId.slice(0, 8) },
          { type: 'raw_text', text: `${(a.activeMinutes / 60).toFixed(1)}` },
          { type: 'raw_text', text: `${a.github.commits}` },
          { type: 'raw_text', text: `${a.jira.ticketUpdates}` },
        ]),
      ],
    });
  }

  // Context footer
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: `_${messages.length} messages | <#${config.channelId}> | GitHub/Jira data may be partial_` }],
  });

  return { text: 'Team Mood & Activity Report', blocks };
}

function getUserLabel(userId, users) {
  const user = users[userId];
  if (user?.name) return user.name.split(' ')[0];
  return userId.slice(0, 6);
}

async function analyzeWithGemini(formatted, activityContext, msgCount) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const prompt = `Analyze this Slack channel conversation for a team manager. Provide in Slack mrkdwn format:

1. *Mood Score:* X/10 (green circle emoji 7+, yellow 4-6, red below 4)
2. *Vibe Meter:* green/white squares proportional to score (10 total)
3. *Top Themes:* 2-3 bullets with emojis
4. *Individual Feelings:* For each active person, show how they seem to feel based on their public messages. Use emojis. Do NOT mention hours/drain/private data.
5. *Attention Needed:* Flag anyone who seems frustrated or stressed. If none, say "All clear!"
6. *Insight:* One actionable sentence for the manager.

Activity context (for your reference, do NOT expose raw numbers to user):
${activityContext}

Messages: ${msgCount}

Conversation:
${formatted}

Rules: Use Slack mrkdwn (*bold*, _italic_). NEVER use ** or ### or HTML. Use warm soothing emojis. The activity data is for your understanding of workload — reflect it in your mood assessment but don't print raw stats.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });
    return response.candidates?.[0]?.content?.parts?.[0]?.text || '_Unable to analyze._';
  } catch (e) {
    console.error(`[team-report] Gemini error: ${e.message}`);
    return `_Analysis unavailable (${e.message}). ${msgCount} messages analyzed._`;
  }
}
