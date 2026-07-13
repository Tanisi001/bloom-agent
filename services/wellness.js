/**
 * Wellness Module — 5-minute cron logic.
 *
 * Every 5 minutes, for each opted-in user:
 *   1. Check if they are currently active
 *   2. Detect if working outside their configured hours (night work)
 *   3. Compute drain score
 *   4. Send appropriate nudge if needed
 */

import { GoogleGenAI } from '@google/genai';
import {
  getAllUsers,
  getUserData,
  updateUserData,
  getWorkingHours,
  getAllTeams,
} from './firebase.js';
import { isUserActive, getSessionDuration, computeDrainScore } from './activity-tracker.js';

// Minimum gap between nudges (in minutes) to avoid spam
const NUDGE_COOLDOWN_MINUTES = 2;

// ======================== MAIN CRON HANDLER ========================

/**
 * Run the wellness check for all teams. Called every 5 minutes.
 * @param {import('@slack/web-api').WebClient} client
 */
export async function runWellnessCheck(client) {
  const teams = await getAllTeams();
  if (!teams) return;

  for (const [teamId, teamConfig] of Object.entries(teams)) {
    if (!teamConfig.channelId) continue;
    try {
      await checkTeamWellness(teamId, client);
    } catch (e) {
      console.error(`[wellness] Error checking team ${teamId}: ${e.message}`);
    }
  }
}

/**
 * Check wellness for all users in a team.
 * @param {string} teamId
 * @param {import('@slack/web-api').WebClient} client
 */
async function checkTeamWellness(teamId, client) {
  const users = await getAllUsers(teamId);
  if (!users) return;

  for (const [userId, userData] of Object.entries(users)) {
    if (userData.optedOut) continue;

    // Check presence via Slack API (detects online even without messages)
    let isOnline = false;
    try {
      const presence = await client.users.getPresence({ user: userId });
      isOnline = presence.presence === 'active';
    } catch { isOnline = false; }

    // User is online — record as activity even if they haven't sent a message
    if (isOnline && !(await isUserActive(teamId, userId))) {
      const { recordEvent } = await import('./activity-tracker.js');
      await recordEvent(teamId, userId, 'slack', 'presence');
    }

    const active = isOnline || await isUserActive(teamId, userId);
    if (!active) continue;

    // User is active — check their situation
    const sessionMinutes = await getSessionDuration(teamId, userId);
    const workingHours = await getWorkingHours(teamId, userId);
    const isOffHours = checkOffHours(workingHours);
    const drainScore = computeDrainScore(sessionMinutes, isOffHours, userData.totalMessages || 0);

    // Update drain score in Firebase
    await updateUserData(teamId, userId, { drainScore });

    // Determine nudge type
    const nudgeType = determineNudgeType(sessionMinutes, isOffHours, drainScore);
    if (!nudgeType) continue;

    // Check cooldown
    if (isOnCooldown(userData, nudgeType)) continue;

    // Send nudge
    await sendWellnessNudge(client, userId, nudgeType, { sessionMinutes, drainScore, isOffHours });
    await updateUserData(teamId, userId, {
      lastNudgeAt: new Date().toISOString(),
      lastNudgeType: nudgeType,
    });
  }
}

// ======================== DETECTION LOGIC ========================

/**
 * Check if current time is outside working hours for the user.
 */
function checkOffHours(workingHours) {
  const now = new Date();
  // Convert to user's timezone
  const userTime = new Date(now.toLocaleString('en-US', { timeZone: workingHours.timezone }));
  const hour = userTime.getHours();
  return hour < workingHours.start || hour >= workingHours.end;
}

/**
 * Determine what type of nudge to send (or null if none needed).
 */
function determineNudgeType(sessionMinutes, isOffHours, drainScore) {
  // Night work — nudge every 5 min check if off-hours and active
  if (isOffHours && sessionMinutes >= 5) return 'night_work';

  // High drain — overworking
  if (drainScore >= 7) return 'high_drain';

  // Long session without break (2+ min)
  if (sessionMinutes >= 2 && sessionMinutes % 2 < 5) return 'break_reminder';

  return null;
}

/**
 * Check if user is still on nudge cooldown.
 */
function isOnCooldown(userData, nudgeType) {
  if (!userData.lastNudgeAt) return false;
  const minutesSinceNudge = (Date.now() - new Date(userData.lastNudgeAt).getTime()) / 60000;

  // Night work nudges are more frequent (every 5 min)
  if (nudgeType === 'night_work') return minutesSinceNudge < 5;

  // Other nudges respect cooldown
  return minutesSinceNudge < NUDGE_COOLDOWN_MINUTES;
}

// ======================== NUDGE GENERATION ========================

/**
 * Generate and send a nudge DM using Gemini.
 */
async function sendWellnessNudge(client, userId, nudgeType, context) {
  try {
    const nudgeText = await generateNudge(nudgeType, context);
    const dm = await client.conversations.open({ users: userId });

    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: nudgeText } },
      { type: 'divider' },
    ];

    // Add promise buttons for actionable nudges
    if (nudgeType !== 'night_work') {
      blocks.push({
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: "I'll take a break!" }, style: 'primary', action_id: 'wellness_promise' },
          { type: 'button', text: { type: 'plain_text', text: 'Maybe later' }, action_id: 'wellness_later' },
        ],
      });
    } else {
      // Night work — gentler, suggest stopping
      blocks.push({
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: "You're right, signing off" }, style: 'primary', action_id: 'wellness_signoff' },
          { type: 'button', text: { type: 'plain_text', text: 'Just finishing up' }, action_id: 'wellness_later' },
        ],
      });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Drain level: ${context.drainScore}/10 | Session: ${context.sessionMinutes} min | ${context.isOffHours ? 'Off-hours' : 'Working hours'}_` }],
    });

    await client.chat.postMessage({ channel: dm.channel.id, text: nudgeText, blocks });
    console.log(`[wellness] Nudged ${userId}: type=${nudgeType}, drain=${context.drainScore}, session=${context.sessionMinutes}min`);
  } catch (e) {
    console.error(`[wellness] Failed to nudge ${userId}: ${e.message}`);
  }
}

/**
 * Use Gemini to generate a contextual nudge message.
 */
async function generateNudge(nudgeType, context) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const prompts = {
    night_work: `Generate a gentle, caring nudge for someone working at night. They have been active for ${context.sessionMinutes} minutes. Their drain level is ${context.drainScore}/10. Remind them sleep matters. Be warm, not preachy. Use soothing emojis. Max 2 sentences. Slack mrkdwn format (*bold*, _italic_). No ** or ###.`,
    high_drain: `Generate a wellness nudge for someone who is overworking. Drain score: ${context.drainScore}/10, active for ${context.sessionMinutes} minutes. They need to stop and recover. Be caring, creative, persuasive. Use soothing emojis. Max 2 sentences. Slack mrkdwn format. No ** or ###.`,
    break_reminder: `Generate a friendly break reminder for someone active for ${context.sessionMinutes} minutes. Suggest water, stretching, or a short walk. Be creative and warm. Use soothing emojis. Max 2 sentences. Slack mrkdwn format. No ** or ###.`,
  };

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts: [{ text: prompts[nudgeType] }] }],
    });
    return response.candidates?.[0]?.content?.parts?.[0]?.text || getFallbackNudge(nudgeType, context);
  } catch {
    return getFallbackNudge(nudgeType, context);
  }
}

/**
 * Fallback nudges if Gemini is unavailable.
 */
function getFallbackNudge(nudgeType, context) {
  const fallbacks = {
    night_work: `\u{1F319} _It's late and you've been going for ${context.sessionMinutes} min._ Tomorrow-you will thank tonight-you for resting now.`,
    high_drain: `\u{1F33F} _Drain level: ${context.drainScore}/10._ You've given a lot today. Time to recharge — even 5 minutes helps.`,
    break_reminder: `\u{2615} _${context.sessionMinutes} minutes of focus!_ Your brain deserves a micro-break. Water, stretch, breathe.`,
  };
  return fallbacks[nudgeType] || 'Time for a break!';
}
