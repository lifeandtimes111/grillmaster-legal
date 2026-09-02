import { CONFIG, appStoreConfigured, googleConfigured } from './config';

export interface Routine {
  /** Stable id, also used as the slash-command name from the phone. */
  name: string;
  description: string;
  /** 5-field cron expression, or undefined to leave it manual-only. */
  cron: string | undefined;
  /** Conversation key, so each routine keeps its own thread of continuity. */
  conversationKey: string;
  prompt: string;
}

const mailLine = googleConfigured
  ? '- Unread mail from the last day that actually needs them: skip newsletters, receipts and ' +
    'promotions unless something is genuinely time-critical. Name the sender and what they want.'
  : '- (Gmail is not connected, so skip mail.)';

const calendarLine = googleConfigured
  ? "- Everything on today's calendar, in order, with anything that needs preparation called out."
  : '- (Calendar is not connected, so skip the schedule.)';

const appStoreLine = appStoreConfigured
  ? "- Yesterday's App Store numbers, and any new review worth reading."
  : '- (App Store Connect is not connected, so skip the numbers.)';

export const ROUTINES: Routine[] = [
  {
    name: 'morning-brief',
    description: 'Schedule, mail that matters, tasks due, and app numbers, first thing.',
    cron: CONFIG.cron.morningBrief,
    conversationKey: 'routine:morning-brief',
    prompt: [
      'Write my morning brief. Gather everything first, then write it.',
      '',
      calendarLine,
      mailLine,
      '- Open tasks that are due today or overdue.',
      appStoreLine,
      '',
      'Then close with "Today" — at most three things that would make the day a success, chosen',
      'from what you just found, in priority order and with a reason for the ordering.',
      '',
      'Write it to be read on a phone over coffee: short lines, no filler, no headings deeper than',
      'one level. If a section has nothing in it, leave it out entirely rather than saying it is',
      'empty. Save the finished brief with save_briefing (kind: "morning-brief").',
    ].join('\n'),
  },
  {
    name: 'inbox-triage',
    description: 'Sort unread mail, draft the obvious replies, surface what needs a decision.',
    cron: CONFIG.cron.inboxTriage,
    conversationKey: 'routine:inbox-triage',
    prompt: [
      'Triage my inbox. Search for unread mail from the last day, excluding promotions and social.',
      '',
      'For each message that matters, decide one of:',
      '- Needs a reply I can write for them: draft it with draft_email and say what you drafted.',
      '- Needs their decision or their voice: summarise it in one line and say what the decision is.',
      '- Contains a commitment or deadline: record it with add_task.',
      '- Noise: ignore it silently.',
      '',
      'Reply with only the second and third categories plus a one-line count of what you drafted.',
      'If nothing needs them, reply with exactly "Inbox clear — nothing needs you." and nothing else.',
    ].join('\n'),
  },
  {
    name: 'evening-review',
    description: 'What closed today, what slipped, and what tomorrow looks like.',
    cron: CONFIG.cron.eveningReview,
    conversationKey: 'routine:evening-review',
    prompt: [
      'Write my evening review.',
      '',
      '- What I completed today (use tasks_completed_since with today\'s date).',
      '- What is still open and now overdue.',
      "- Tomorrow's schedule, and anything on it I should prepare tonight.",
      '',
      'Then name the single most useful thing I could do first tomorrow, and why that one.',
      'Keep it under 200 words. If a whole section is empty, drop it.',
    ].join('\n'),
  },
  {
    name: 'weekly-research',
    description: 'Weekly scan of the market around my apps.',
    cron: CONFIG.cron.weeklyResearch,
    conversationKey: 'routine:weekly-research',
    prompt: [
      'Do my weekly research scan. Use recall first to see what I am working on and what you',
      'covered last week, so this builds on it rather than repeating it.',
      '',
      'Search the web for anything that changed in the last week that affects my apps or my work:',
      'competing apps and their updates, App Store policy or review-guideline changes, iOS release',
      'notes that touch what I ship, and any shift in what people are searching for in my category.',
      '',
      'Report only what changed and what I should do about it. Every claim gets a source link.',
      'If a week is genuinely quiet, say so in one line rather than padding it — a thin week',
      'honestly reported is more useful than a full page of noise. Save it with save_briefing',
      '(kind: "weekly-research") and record any follow-up as a task.',
    ].join('\n'),
  },
];

export function findRoutine(name: string): Routine | undefined {
  return ROUTINES.find((routine) => routine.name === name);
}
