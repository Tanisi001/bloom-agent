import 'dotenv/config';

import { App, LogLevel } from '@slack/bolt';
import cron from 'node-cron';

import { initMcpTools } from './agent/index.js';
import { registerListeners } from './listeners/index.js';
import { recordEvent } from './services/activity-tracker.js';
import { runWellnessCheck } from './services/wellness.js';
import { onboardInstaller, greetTeamMembers } from './services/onboarding.js';
import { getTeamConfig, updateUserData, getAllTeams, getAllUsers } from './services/firebase.js';

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.DEBUG,
  ignoreSelf: false,
});

registerListeners(app);

// ======================== ACTIVITY TRACKING VIA SLACK EVENTS ========================

app.event('message', async ({ event, context }) => {
  if (event.bot_id || event.subtype) return;
  const teamId = context.teamId || event.team || 'default';
  const userId = event.user;
  if (userId) await recordEvent(teamId, userId, 'slack', 'message');
});

app.event('reaction_added', async ({ event, context }) => {
  const teamId = context.teamId || 'default';
  const userId = event.user;
  if (userId) await recordEvent(teamId, userId, 'slack', 'reaction');
});

// ======================== OPT-IN / OPT-OUT / WELLNESS BUTTONS ========================

app.action('wellness_opt_in', async ({ ack, body, client }) => {
  await ack();
  const teamId = body.team?.id || body.user?.team_id || body.enterprise?.id || 'default';
  const userId = body.user.id;
  console.log(`[opt-in] user=${userId}, team=${teamId}`);
  await updateUserData(teamId, userId, { optedOut: false });
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "Awesome! I'll keep an eye on your wellness. You're in good hands!",
  });
  // Ask for GitHub username
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "One quick thing — what's your GitHub username? This helps me track your overall activity better.",
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: "One quick thing \u2014 what's your *GitHub username*? This helps me understand your overall workload better." } },
      {
        type: 'actions',
        elements: [
          { type: 'button', text: { type: 'plain_text', text: "Skip for now" }, action_id: 'github_skip' },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '_Just reply with your GitHub username (e.g. "octocat") or click Skip._' }] },
    ],
  });
  if (global.startWellnessCron) global.startWellnessCron();
});

app.action('github_skip', async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "No problem! You can always tell me later by saying \"my github is username\".",
  });
});

app.action('wellness_opt_out', async ({ ack, body, client }) => {
  await ack();
  const teamId = body.team?.id || body.user?.team_id || body.enterprise?.id || 'default';
  const userId = body.user.id;
  console.log(`[opt-out] user=${userId}, team=${teamId}`);
  await updateUserData(teamId, userId, { optedOut: true });
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "No worries! I won't send you wellness reminders. Say \"opt in\" anytime to come back.",
  });
});

app.action('wellness_promise', async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "That's a promise! I'll check back in 5 minutes. Go take that break!",
  });
  setTimeout(async () => {
    try {
      await client.chat.postMessage({
        channel: body.channel.id,
        text: "Hey! Did you keep your promise?",
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'Hey! Did you do it? Be honest :eyes:' } },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: "Yes I did!" }, style: 'primary', action_id: 'wellness_done' },
              { type: 'button', text: { type: 'plain_text', text: "Not yet..." }, action_id: 'wellness_not_done' },
            ],
          },
        ],
      });
    } catch (e) { console.error(`[wellness] Follow-up failed: ${e.message}`); }
  }, 5 * 60 * 1000);
});

app.action('wellness_later', async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "No pressure! Even 30 seconds of stretching makes a difference. I believe in you.",
  });
});

app.action('wellness_signoff', async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "Good call. Rest well tonight! Tomorrow is a new day.",
  });
});

app.action('wellness_done', async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "You're amazing! Your body thanks you. Back to crushing it!",
  });
});

app.action('wellness_not_done', async ({ ack, body, client }) => {
  await ack();
  await client.chat.postMessage({
    channel: body.channel.id,
    text: "Hey, no judgment! But do it *right now* \u2014 just 30 seconds. I'll wait.",
  });
});

// ======================== ONBOARDING ========================

app.event('app_home_opened', async ({ event, context, client }) => {
  const teamId = context.teamId || 'default';
  const config = await getTeamConfig(teamId);

  // Only onboard if NO installer has been set yet (first time only)
  // And only if the user opening is the first one (they become the installer)
  if (!config.installerId) {
    await onboardInstaller(client, event.user, teamId);
  }
  // Do NOT send configure prompts to other users who open App Home
});

// ======================== CONFIGURE COMPLETION HOOK ========================

global.onConfigureComplete = async (teamId, channelId) => {
  try {
    app.logger.info(`[onboarding] Greeting team in <#${channelId}>`);
    await greetTeamMembers(app.client, teamId, channelId);
    app.logger.info(`[onboarding] Complete for team ${teamId}`);
  } catch (e) {
    app.logger.error(`[onboarding] Failed: ${e.message}`);
  }
};

// ======================== WELLNESS CRON (EVERY 5 MIN) ========================

let wellnessCronStarted = false;

function startWellnessCron() {
  if (wellnessCronStarted) return;
  wellnessCronStarted = true;
  cron.schedule('*/5 * * * *', async () => {
    try {
      await runWellnessCheck(app.client);
    } catch (e) {
      console.error(`[cron] Wellness check error: ${e.message}`);
    }
  });
  app.logger.info('[cron] Wellness cron started (every 5 min)');
}

global.startWellnessCron = startWellnessCron;

// ======================== START ========================

(async () => {
  await initMcpTools();
  await app.start();
  app.logger.info('Bloom is running!');

  const teams = await getAllTeams();
  const teamCount = teams ? Object.keys(teams).length : 0;
  app.logger.info(`[startup] ${teamCount} team(s) loaded.`);

  if (teamCount > 0) {
    // Start cron only if any user is opted in
    let hasOptedIn = false;
    for (const teamId of Object.keys(teams)) {
      const users = await getAllUsers(teamId);
      if (users && Object.values(users).some((u) => !u.optedOut)) {
        hasOptedIn = true;
        break;
      }
    }
    if (hasOptedIn) startWellnessCron();
    else app.logger.info('[startup] No opted-in users. Cron starts on first opt-in.');
  } else {
    app.logger.info('[startup] No teams yet. Cron starts after first opt-in.');
  }
})();
