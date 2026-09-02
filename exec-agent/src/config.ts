import { config as loadEnv } from 'dotenv';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

loadEnv();

/**
 * Everything personal lives outside the repo. The repo holds code; this
 * directory holds the assistant's memory, credentials and logs.
 */
export const DATA_DIR = process.env.EXEC_AGENT_HOME ?? join(homedir(), '.exec-agent');

export const PATHS = {
  data: DATA_DIR,
  credentials: join(DATA_DIR, 'credentials'),
  logs: join(DATA_DIR, 'logs'),
  tasks: join(DATA_DIR, 'tasks.json'),
  memory: join(DATA_DIR, 'memory.json'),
  sessions: join(DATA_DIR, 'sessions.json'),
  briefings: join(DATA_DIR, 'briefings'),
  googleToken: join(DATA_DIR, 'credentials', 'google.json'),
  profile: join(DATA_DIR, 'PROFILE.md'),
} as const;

for (const dir of [PATHS.data, PATHS.credentials, PATHS.logs, PATHS.briefings]) {
  mkdirSync(dir, { recursive: true });
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const CONFIG = {
  model: optional('EXEC_AGENT_MODEL') ?? 'claude-opus-5',
  timezone: optional('EXEC_AGENT_TIMEZONE') ?? 'America/New_York',

  telegram: {
    token: optional('TELEGRAM_BOT_TOKEN'),
    ownerChatId: optional('TELEGRAM_OWNER_CHAT_ID'),
  },

  google: {
    clientId: optional('GOOGLE_CLIENT_ID'),
    clientSecret: optional('GOOGLE_CLIENT_SECRET'),
  },

  appStore: {
    keyId: optional('ASC_KEY_ID'),
    issuerId: optional('ASC_ISSUER_ID'),
    privateKeyPath: optional('ASC_PRIVATE_KEY_PATH'),
    vendorNumber: optional('ASC_VENDOR_NUMBER'),
  },

  cron: {
    morningBrief: optional('CRON_MORNING_BRIEF'),
    inboxTriage: optional('CRON_INBOX_TRIAGE'),
    eveningReview: optional('CRON_EVENING_REVIEW'),
    weeklyResearch: optional('CRON_WEEKLY_RESEARCH'),
  },
} as const;

export const googleConfigured = Boolean(CONFIG.google.clientId && CONFIG.google.clientSecret);

export const appStoreConfigured = Boolean(
  CONFIG.appStore.keyId && CONFIG.appStore.issuerId && CONFIG.appStore.privateKeyPath,
);

export const telegramConfigured = Boolean(CONFIG.telegram.token && CONFIG.telegram.ownerChatId);

/** Current wall-clock time in the user's timezone, for prompts and filenames. */
export function nowLocal(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: CONFIG.timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Today's date as YYYY-MM-DD in the user's timezone. */
export function todayLocal(): string {
  // en-CA renders as YYYY-MM-DD, which is what we want for sorting and filenames.
  return new Date().toLocaleDateString('en-CA', { timeZone: CONFIG.timezone });
}
