/**
 * Firebase Realtime Database service layer.
 *
 * Data model:
 *
 *   /teams/{teamId}
 *     - installerId: string
 *     - channelId: string (monitored channel)
 *     - channelName: string
 *     - workingHoursStart: number (default 9)
 *     - workingHoursEnd: number (default 17)
 *     - createdAt: ISO timestamp
 *
 *   /users/{teamId}/{userId}
 *     - optedOut: boolean
 *     - email: string
 *     - name: string
 *     - timezone: string (IANA, e.g. "Asia/Kolkata")
 *     - workingHoursStart: number (user override, default from team)
 *     - workingHoursEnd: number
 *     - lastActiveAt: ISO timestamp
 *     - sessionStartedAt: ISO timestamp (when current active session began)
 *     - activeMinutes: number (continuous)
 *     - drainScore: number (0-10, computed)
 *     - lastNudgeAt: ISO timestamp
 *     - lastNudgeType: string (e.g. 'night_work', 'overwork', 'hydrate')
 *
 *   /activity/{teamId}/{userId}/{date}
 *     - totalMessages: number
 *     - totalReactions: number
 *     - activePeriods: [{start, end}] (session windows)
 *     - sources: { slack: {...}, github: {...}, jira: {...} }
 */

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || 'https://reminder-4e6d4.firebaseio.com';

// ======================== GENERIC HELPERS ========================

async function fbGet(path) {
  try {
    const res = await fetch(`${FIREBASE_DB_URL}/${path}.json`);
    return await res.json();
  } catch { return null; }
}

async function fbSet(path, data) {
  await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

async function fbUpdate(path, data) {
  await fetch(`${FIREBASE_DB_URL}/${path}.json`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

// ======================== TEAM CONFIG ========================

const DEFAULT_TEAM_CONFIG = {
  installerId: null,
  channelId: null,
  channelName: null,
  workingHoursStart: 9,
  workingHoursEnd: 17,
  createdAt: null,
};

export async function getTeamConfig(teamId) {
  const data = await fbGet(`teams/${teamId}`);
  return data || { ...DEFAULT_TEAM_CONFIG };
}

export async function saveTeamConfig(teamId, config) {
  await fbSet(`teams/${teamId}`, config);
}

export async function updateTeamConfig(teamId, updates) {
  await fbUpdate(`teams/${teamId}`, updates);
}

// ======================== USER DATA ========================

const DEFAULT_USER_DATA = {
  optedOut: true,
  email: null,
  name: null,
  timezone: 'Asia/Kolkata',
  workingHoursStart: null, // null = use team default
  workingHoursEnd: null,
  lastActiveAt: null,
  sessionStartedAt: null,
  activeMinutes: 0,
  drainScore: 0,
  lastNudgeAt: null,
  lastNudgeType: null,
};

export async function getUserData(teamId, userId) {
  const data = await fbGet(`users/${teamId}/${userId}`);
  return data || { ...DEFAULT_USER_DATA };
}

export async function saveUserData(teamId, userId, data) {
  await fbSet(`users/${teamId}/${userId}`, data);
}

export async function updateUserData(teamId, userId, updates) {
  await fbUpdate(`users/${teamId}/${userId}`, updates);
}

export async function getAllUsers(teamId) {
  const data = await fbGet(`users/${teamId}`);
  return data || {};
}

export async function isUserOptedOut(teamId, userId) {
  const user = await getUserData(teamId, userId);
  return user.optedOut === true;
}

// ======================== ACTIVITY LOG ========================

export async function logActivity(teamId, userId, date, source, data) {
  await fbUpdate(`activity/${teamId}/${userId}/${date}/sources/${source}`, data);
}

export async function getActivityLog(teamId, userId, date) {
  return await fbGet(`activity/${teamId}/${userId}/${date}`);
}

export async function incrementDailyCounter(teamId, userId, date, field) {
  const current = await fbGet(`activity/${teamId}/${userId}/${date}/${field}`);
  await fbSet(`activity/${teamId}/${userId}/${date}/${field}`, (current || 0) + 1);
}

// ======================== HELPERS ========================

/**
 * Get user's effective working hours (user override > team default).
 */
export async function getWorkingHours(teamId, userId) {
  const user = await getUserData(teamId, userId);
  const team = await getTeamConfig(teamId);
  return {
    start: user.workingHoursStart ?? team.workingHoursStart ?? 9,
    end: user.workingHoursEnd ?? team.workingHoursEnd ?? 17,
    timezone: user.timezone || 'Asia/Kolkata',
  };
}

/**
 * Get all teams from Firebase.
 */
export async function getAllTeams() {
  const data = await fbGet('teams');
  return data || {};
}
