import { runAgent } from '../../agent/index.js';
import { sessionStore } from '../../thread-context/index.js';
import { buildFeedbackBlocks } from '../views/feedback-builder.js';

/**
 * @param {import('@slack/types').MessageEvent} event
 * @returns {event is import('@slack/types').GenericMessageEvent}
 */
function isGenericMessageEvent(event) {
  return !('subtype' in event && event.subtype !== undefined);
}

/**
 * Handle messages sent to the agent via DM or in threads the bot is part of.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackEventMiddlewareArgs<'message'>} args
 * @returns {Promise<void>}
 */
export async function handleMessage({ client, context, event, logger, say, sayStream, setStatus }) {
  // Skip message subtypes (edits, deletes, etc.)
  if (!isGenericMessageEvent(event)) return;

  // Skip bot messages
  if (event.bot_id) return;

  const isDm = event.channel_type === 'im';
  const isThreadReply = !!event.thread_ts;

  if (isDm) {
    // DMs are always handled
  } else if (isThreadReply) {
    // Channel thread replies are handled only if the bot is already engaged
    const history = sessionStore.getHistory(event.channel, /** @type {string} */ (event.thread_ts));
    if (history === null) return;
  } else {
    // Top-level channel messages are handled by app_mentioned
    return;
  }

  try {
    const channelId = event.channel;
    const text = event.text || '';
    const threadTs = event.thread_ts || event.ts;
    const userId = /** @type {string} */ (context.userId);
    const teamId = context.teamId || event.team || 'default';

    // Check if this is a GitHub username reply (short text, in DM, looks like a username)
    if (isDm && text.trim().length > 0 && text.trim().length <= 39 && /^[a-zA-Z0-9]([a-zA-Z0-9\-]*[a-zA-Z0-9])?$/.test(text.trim())) {
      // Check recent conversation history OR if it's a thread reply to the GitHub question
      const history = sessionStore.getHistory(channelId, threadTs) ?? [];
      const recentTexts = history.filter((h) => h.role === 'model').map((h) => h.parts?.map((p) => p.text || '').join('')).join(' ');

      // Also check by fetching recent bot messages in DM
      let askedForGithub = recentTexts.includes('GitHub username') || recentTexts.includes('github');
      if (!askedForGithub) {
        try {
          const recent = await client.conversations.history({ channel: channelId, limit: 5 });
          const botMsgs = (recent.messages || []).filter((m) => m.bot_id);
          askedForGithub = botMsgs.some((m) => (m.text || '').includes('GitHub username'));
        } catch {}
      }

      if (askedForGithub) {
        const { updateUserData } = await import('../../services/firebase.js');
        await updateUserData(teamId, userId, { githubUsername: text.trim() });
        await say({ text: `Got it! GitHub username saved as *${text.trim()}*. I'll use this to track your contributions.`, thread_ts: threadTs });
        return;
      }
    }

    // Get conversation history for context
    const existingHistory = sessionStore.getHistory(channelId, threadTs) ?? [];

    // Set assistant thread status with loading messages
    await setStatus({
      status: 'Thinking\u2026',
      loading_messages: [
        'Teaching the hamsters to type faster\u2026',
        'Untangling the internet cables\u2026',
        'Consulting the office goldfish\u2026',
        'Polishing up the response just for you\u2026',
        'Convincing the AI to stop overthinking\u2026',
      ],
    });

    // Run the agent with deps for tool access
    const deps = { client, userId, channelId, threadTs, messageTs: event.ts, userToken: context.userToken, teamId: context.teamId || event.team || 'default', originalText: text };
    const { responseText, history: newHistory } = await runAgent(text, existingHistory, deps);

    // Stream response in thread with feedback buttons
    const streamer = sayStream();
    await streamer.append({ markdown_text: responseText });
    const feedbackBlocks = buildFeedbackBlocks();
    await streamer.stop({ blocks: feedbackBlocks });

    // Store conversation history for future context
    sessionStore.setHistory(channelId, threadTs, newHistory);
  } catch (e) {
    logger.error(`Failed to handle message: ${e}`);
    await say({
      text: `:warning: Something went wrong! (${e})`,
      thread_ts: event.thread_ts || event.ts,
    });
  }
}
