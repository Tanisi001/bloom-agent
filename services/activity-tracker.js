/**
 * Activity Tracker — Pluggable multi-source activity system.
 *
 * Sources:
 *   - Slack: messages, reactions, presence (primary)
 *   - GitHub: commits, PRs (via MCP tools)
 *   - Jira: ticket updates (via MCP tools)
 *
 * If GitHub/Jira return errors, we log a warning and continue with Slack data only.
 */

import {
  getUserData,
  updateUserData,
  incrementDailyCounter,
  isUserOptedOut,
} from './firebase.js';

// ======================== SOURCE REGISTRY ========================

export const ACTIVITY_SOURCES = {
  slack: { weight: 1.0, label: 'Slack' },
  github: { weight: 0.8, label: 'GitHub' },
  jira: { weight: 0.6, label: 'Jira' },
};

// ======================== RECORD ACTIVITY ========================

/**
 * Record a user activity event from any source.
 * @param {string} teamId
 * @param {string} userId
 * @param {string} source - 'slack' | 'github' | 'jira'
 * @param {string} eventType - 'message' | 'reaction' | 'presence' | 'commit' | 'pr' | 'ticket_update'
 */
export async function recordEvent(teamId, userId, source, eventType) {
  if (await isUserOptedOut(teamId, userId)) return;

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const today = new Date(now).toISOString().split('T')[0];
  const userData = await getUserData(teamId, userId);

  // Update daily counter
  await incrementDailyCounter(teamId, userId, today, `${source}_${eventType}`);

  // Session tracking: 5-min gap = new session
  const lastActive = userData.lastActiveAt ? new Date(userData.lastActiveAt).getTime() : 0;
  const gapMinutes = lastActive ? (now - lastActive) / 60000 : Infinity;

  if (gapMinutes <= 5) {
    const elapsed = Math.round(gapMinutes);
    const newActive = (userData.activeMinutes || 0) + Math.max(elapsed, 1);
    await updateUserData(teamId, userId, { lastActiveAt: nowIso, activeMinutes: newActive });
  } else {
    await updateUserData(teamId, userId, { lastActiveAt: nowIso, sessionStartedAt: nowIso, activeMinutes: 1 });
  }
}

// ======================== QUERY HELPERS ========================

/**
 * Check if a user is currently active (activity within last 5 min).
 */
export async function isUserActive(teamId, userId) {
  const userData = await getUserData(teamId, userId);
  if (!userData.lastActiveAt) return false;
  const gap = (Date.now() - new Date(userData.lastActiveAt).getTime()) / 60000;
  return gap <= 5;
}

/**
 * Get user's current session duration in minutes.
 */
export async function getSessionDuration(teamId, userId) {
  const userData = await getUserData(teamId, userId);
  if (!userData.sessionStartedAt) return 0;
  return Math.round((Date.now() - new Date(userData.sessionStartedAt).getTime()) / 60000);
}

/**
 * Compute drain score (0-10).
 * Factors: duration, off-hours, intensity, multi-source activity.
 */
export function computeDrainScore(activeMinutes, isOffHours, messageCount = 0, githubActivity = 0, jiraActivity = 0) {
  const durationDrain = Math.min(activeMinutes / 48, 5);
  const offHoursMultiplier = isOffHours ? 1.5 : 1.0;
  const msgPerMin = activeMinutes > 0 ? messageCount / activeMinutes : 0;
  const intensityDrain = Math.min(msgPerMin * 2, 2);

  // Multi-source bonus: active across multiple tools = higher drain
  const multiSourceBonus = (githubActivity > 0 ? 0.5 : 0) + (jiraActivity > 0 ? 0.5 : 0);

  const raw = (durationDrain + intensityDrain + multiSourceBonus) * offHoursMultiplier;
  return Math.min(Math.round(raw * 10) / 10, 10);
}

// ======================== GITHUB ACTIVITY FETCH ========================

/**
 * Fetch today's GitHub contributions for a user.
 * Uses githubUsername if available, otherwise email.
 *
 * @param {object} userInfo - { email, githubUsername }
 * @param {function} callMcpTool - MCP tool caller
 * @returns {Promise<{commits: number, prs: number}>}
 */
export async function fetchGithubActivity(userInfo, callMcpTool) {
  if (!callMcpTool) return { commits: 0, prs: 0 };
  const author = userInfo?.githubUsername || userInfo?.email;
  if (!author) return { commits: 0, prs: 0 };

  try {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const result = await callMcpTool('list_commits', { author, since });
    const commits = (result.match(/commit/gi) || []).length || 0;
    return { commits, prs: 0 };
  } catch (e) {
    console.warn(`[activity] GitHub fetch failed for ${author}: ${e.message}`);
    return { commits: 0, prs: 0 };
  }
}

// ======================== JIRA ACTIVITY FETCH ========================

/**
 * Fetch today's Jira activity for a user using their email.
 *
 * @param {object} userInfo - { email }
 * @param {function} callMcpTool - MCP tool caller
 * @returns {Promise<{ticketUpdates: number}>}
 */
export async function fetchJiraActivity(userInfo, callMcpTool) {
  if (!callMcpTool || !userInfo?.email) return { ticketUpdates: 0 };

  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await callMcpTool('jira_get', {
      path: '/rest/api/3/search/jql',
      query: { jql: `assignee="${userInfo.email}" AND updated >= "${today}"` },
    });
    const parsed = typeof result === 'string' ? result : JSON.stringify(result);
    const match = parsed.match(/"total"\s*:\s*(\d+)/);
    return { ticketUpdates: match ? parseInt(match[1]) : 0 };
  } catch (e) {
    console.warn(`[activity] Jira fetch failed for ${userInfo.email}: ${e.message}`);
    return { ticketUpdates: 0 };
  }
}

// ======================== AGGREGATE USER ACTIVITY ========================

/**
 * Get full activity summary for a user (all sources).
 * Gracefully handles GitHub/Jira failures.
 *
 * @param {string} teamId
 * @param {string} userId
 * @param {object} [mcpTools] - { callMcpTool, userInfo: { email, name, githubUsername } }
 * @returns {Promise<object>}
 */
export async function getUserActivitySummary(teamId, userId, mcpTools = null) {
  const userData = await getUserData(teamId, userId);
  const sessionMinutes = await getSessionDuration(teamId, userId);

  let github = { commits: 0, prs: 0 };
  let jira = { ticketUpdates: 0 };

  if (mcpTools?.callMcpTool && mcpTools?.userInfo) {
    github = await fetchGithubActivity(mcpTools.userInfo, mcpTools.callMcpTool);
    jira = await fetchJiraActivity(mcpTools.userInfo, mcpTools.callMcpTool);
  }

  return {
    activeMinutes: userData.activeMinutes || 0,
    sessionMinutes,
    lastActiveAt: userData.lastActiveAt,
    github,
    jira,
    drainScore: userData.drainScore || 0,
  };
}
