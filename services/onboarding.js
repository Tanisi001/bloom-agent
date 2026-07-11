/**
 * Onboarding Module.
 *
 * Handles:
 * 1. DM to installer on app install - prompt to configure channel
 * 2. After config - DM all team members with greeting + opt-out option
 */

import { saveTeamConfig, saveUserData } from './firebase.js';
import { GoogleGenAI } from '@google/genai';

/**
 * Generate a unique onboarding greeting using Gemini.
 * @returns {Promise<{quote: string, body: string}>}
 */
async function generateGreeting() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [{ text: `Generate a warm, friendly onboarding message for a Slack wellness bot. Return JSON with:
- "quote": a short inspiring health/wellness quote with author (not overused ones)
- "body": 2-3 sentences welcoming them, explaining you'll remind them to hydrate, stretch, rest eyes, breathe. Make it feel like a caring friend, not corporate. Use Slack mrkdwn (*bold*). Include relevant emojis. Do NOT use ** or ###.` }] }],
    config: { responseMimeType: 'application/json' },
  });
  try {
    return JSON.parse(response.candidates[0].content.parts[0].text);
  } catch {
    return { quote: '"Take care of your body. It is the only place you have to live." \u2014 Jim Rohn', body: "Your team just set up *Wellness Buddy*! I'll gently remind you to hydrate, stretch, and breathe based on your activity." };
  }
}

/**
 * Send onboarding DM to the installer (SDM).
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} userId - installer user ID
 * @param {string} teamId
 */
export async function onboardInstaller(client, userId, teamId) {
  const dm = await client.conversations.open({ users: userId });

  await client.chat.postMessage({
    channel: dm.channel.id,
    text: "Welcome! Let's set up Bloom for your team.",
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Welcome to Bloom' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*"The greatest wealth is health."* \u2014 Virgil\n\nI'm here to keep your team energised, balanced, and productive. I'll gently remind folks to hydrate, stretch, and breathe \u2014 without being annoying.`,
        },
      },
      { type: 'divider' },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*To get started, just tell me your team channel:*\n\n\u2022 \`configure #your-team-channel\`\n\nThat's it! I'll greet your team and start taking care of them.\n\nYou can also set team working hours:\n\u2022 \`configure #channel working hours 9am to 6pm\`\n\n*For best results:* Add me to all your team's channels using \`/invite @Bloom\` in each channel. The more channels I'm in, the more accurately I can track activity and mood.`,
        },
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `_You can reconfigure anytime. Just say "configure" again._` }],
      },
    ],
  });

  await saveTeamConfig(teamId, {
    installerId: userId,
    channelId: null,
    channelName: null,
    cronSchedule: '30 16 * * *',
    lookbackHours: 12,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Send greeting DM to all members of the configured channel.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} teamId
 * @param {string} channelId
 */
export async function greetTeamMembers(client, teamId, channelId) {
  let members = [];
  try {
    const result = await client.conversations.members({ channel: channelId });
    members = result.members || [];
  } catch (e) {
    console.error(`[onboarding] Failed to get channel members: ${e.message}`);
    return;
  }

  // Get installer ID to skip them from greeting
  const { getTeamConfig } = await import('./firebase.js');
  const teamConfig = await getTeamConfig(teamId);
  const installerId = teamConfig.installerId;

  const greetedUsers = [];

  for (const userId of members) {
    // Skip the installer — they get a summary instead
    if (userId === installerId) continue;

    let userEmail = null;
    let userName = null;
    try {
      const info = await client.users.info({ user: userId });
      if (info.user.is_bot) continue;
      userEmail = info.user.profile?.email || null;
      userName = info.user.real_name || info.user.name || null;
    } catch { continue; }

    await saveUserData(teamId, userId, {
      optedOut: true,
      email: userEmail,
      name: userName,
      lastActiveAt: null,
      activeMinutes: 0,
      lastNudgeAt: null,
      nudgeThresholdMinutes: 30,
    });

    await sendGreeting(client, userId);
    greetedUsers.push({ userId, name: userName, email: userEmail });
  }

  // Send summary to installer
  if (installerId && greetedUsers.length > 0) {
    const userList = greetedUsers.map((u) => `\u2022 <@${u.userId}> (${u.email || 'no email'})`).join('\n');
    try {
      const dm = await client.conversations.open({ users: installerId });
      await client.chat.postMessage({
        channel: dm.channel.id,
        text: `Team onboarded!`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: 'Team Onboarded!' } },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `I've sent a friendly welcome to *${greetedUsers.length} team members* with opt-in/out options:\n\n${userList}` },
          },
        ],
      });
    } catch (e) {
      console.error(`[onboarding] Failed to notify installer: ${e.message}`);
    }
  }
}

/**
 * Send a greeting DM to a team member.
 * @param {import('@slack/web-api').WebClient} client
 * @param {string} userId
 */
async function sendGreeting(client, userId) {
  try {
    const { quote, body } = await generateGreeting();
    const dm = await client.conversations.open({ users: userId });

    await client.chat.postMessage({
      channel: dm.channel.id,
      text: "Your team just enabled Wellness Buddy!",
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Hey there, superstar!' } },
        { type: 'section', text: { type: 'mrkdwn', text: `_${quote}_` } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: body } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: 'Sounds great!' }, style: 'primary', action_id: 'wellness_opt_in' },
            { type: 'button', text: { type: 'plain_text', text: 'No thanks, opt me out' }, action_id: 'wellness_opt_out' },
          ],
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `_You can change your mind anytime by saying "opt out" or "opt in"._` }] },
      ],
    });
  } catch (e) {
    console.error(`[onboarding] Failed to greet ${userId}: ${e.message}`);
  }
}
