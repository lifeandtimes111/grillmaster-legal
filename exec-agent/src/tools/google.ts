import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { CONFIG } from '../config';
import { calendar, gmail, extractBody, header, buildRawMessage } from './google-client';
import { text, fail, guarded } from './helpers';

const listCalendarEvents = tool(
  'list_calendar_events',
  'List calendar events in a time range. Use this to answer anything about the schedule, ' +
    'to prepare for meetings, or to find a free slot.',
  {
    days_ahead: z
      .number()
      .int()
      .min(0)
      .max(60)
      .default(1)
      .describe('How many days forward from now to include. 0 means the rest of today.'),
    calendar_id: z.string().default('primary').describe('Calendar to read; "primary" by default.'),
  },
  guarded('list_calendar_events', async (args) => {
    const now = new Date();
    const end = new Date(now.getTime() + Math.max(args.days_ahead, 0) * 86_400_000);
    // days_ahead 0 should still cover the remainder of today.
    if (args.days_ahead === 0) end.setHours(23, 59, 59, 999);

    const response = await calendar().events.list({
      calendarId: args.calendar_id,
      timeMin: now.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    });

    const events = response.data.items ?? [];
    if (events.length === 0) return text('No events in that window.');

    const lines = events.map((event) => {
      const start = event.start?.dateTime ?? event.start?.date ?? '?';
      const when = event.start?.dateTime
        ? new Date(start).toLocaleString('en-US', {
            timeZone: CONFIG.timezone,
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : `${start} (all day)`;
      const guests = (event.attendees ?? [])
        .map((attendee) => attendee.email)
        .filter(Boolean)
        .slice(0, 8);
      const parts = [`- ${when} — ${event.summary ?? '(no title)'}`];
      if (event.location) parts.push(`  location: ${event.location}`);
      if (guests.length > 0) parts.push(`  with: ${guests.join(', ')}`);
      if (event.hangoutLink) parts.push(`  meet: ${event.hangoutLink}`);
      return parts.join('\n');
    });

    return text(lines.join('\n'));
  }),
  { annotations: { readOnlyHint: true } },
);

const createCalendarEvent = tool(
  'create_calendar_event',
  'Create a calendar event. Times must be ISO 8601 with an offset, e.g. 2026-09-04T15:00:00-04:00.',
  {
    summary: z.string().describe('Event title.'),
    start: z.string().describe('ISO 8601 start time with UTC offset.'),
    end: z.string().describe('ISO 8601 end time with UTC offset.'),
    description: z.string().default('').describe('Event body.'),
    location: z.string().default('').describe('Physical location or call link.'),
    attendees: z.array(z.string()).default([]).describe('Attendee email addresses.'),
  },
  guarded('create_calendar_event', async (args) => {
    const response = await calendar().events.insert({
      calendarId: 'primary',
      requestBody: {
        summary: args.summary,
        start: { dateTime: args.start, timeZone: CONFIG.timezone },
        end: { dateTime: args.end, timeZone: CONFIG.timezone },
        ...(args.description ? { description: args.description } : {}),
        ...(args.location ? { location: args.location } : {}),
        ...(args.attendees.length > 0
          ? { attendees: args.attendees.map((email) => ({ email })) }
          : {}),
      },
    });
    return text(`Created "${args.summary}" — ${response.data.htmlLink ?? 'no link returned'}`);
  }),
);

const searchEmail = tool(
  'search_email',
  'Search Gmail and return message summaries (id, from, subject, date, snippet). ' +
    'Supports full Gmail query syntax, e.g. "is:unread newer_than:1d -category:promotions".',
  {
    query: z.string().describe('Gmail search query.'),
    max_results: z.number().int().min(1).max(50).default(15),
  },
  guarded('search_email', async (args) => {
    const client = gmail();
    const list = await client.users.messages.list({
      userId: 'me',
      q: args.query,
      maxResults: args.max_results,
    });

    const ids = (list.data.messages ?? []).map((message) => message.id).filter(Boolean);
    if (ids.length === 0) return text(`No messages matched: ${args.query}`);

    const summaries = await Promise.all(
      ids.map(async (id) => {
        const detail = await client.users.messages.get({
          userId: 'me',
          id: id as string,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });
        const headers = detail.data.payload?.headers ?? undefined;
        return [
          `id: ${id}`,
          `from: ${header(headers, 'From')}`,
          `subject: ${header(headers, 'Subject')}`,
          `date: ${header(headers, 'Date')}`,
          `snippet: ${detail.data.snippet ?? ''}`,
        ].join('\n');
      }),
    );

    return text(summaries.join('\n---\n'));
  }),
  { annotations: { readOnlyHint: true } },
);

const readEmail = tool(
  'read_email',
  'Read the full body of one Gmail message by id. Use after search_email when the snippet is not enough.',
  { message_id: z.string().describe('Gmail message id from search_email.') },
  guarded('read_email', async (args) => {
    const detail = await gmail().users.messages.get({
      userId: 'me',
      id: args.message_id,
      format: 'full',
    });
    const headers = detail.data.payload?.headers ?? undefined;
    const body = extractBody(detail.data.payload);

    return text(
      [
        `from: ${header(headers, 'From')}`,
        `to: ${header(headers, 'To')}`,
        `subject: ${header(headers, 'Subject')}`,
        `date: ${header(headers, 'Date')}`,
        '',
        // Long threads blow out the context window for little gain.
        body.length > 8000 ? `${body.slice(0, 8000)}\n\n[truncated]` : body,
      ].join('\n'),
    );
  }),
  { annotations: { readOnlyHint: true } },
);

const draftEmail = tool(
  'draft_email',
  'Save a Gmail draft. Prefer this over send_email whenever the message can wait for a human look.',
  {
    to: z.string().describe('Recipient address.'),
    subject: z.string(),
    body: z.string(),
    cc: z.string().default(''),
  },
  guarded('draft_email', async (args) => {
    const raw = buildRawMessage({
      to: args.to,
      subject: args.subject,
      body: args.body,
      ...(args.cc ? { cc: args.cc } : {}),
    });
    const response = await gmail().users.drafts.create({
      userId: 'me',
      requestBody: { message: { raw } },
    });
    return text(`Draft saved (id ${response.data.id}) to ${args.to}: "${args.subject}"`);
  }),
);

const sendEmail = tool(
  'send_email',
  'Send an email immediately. This is irreversible — only use it when explicitly asked to send.',
  {
    to: z.string().describe('Recipient address.'),
    subject: z.string(),
    body: z.string(),
    cc: z.string().default(''),
  },
  guarded('send_email', async (args) => {
    const raw = buildRawMessage({
      to: args.to,
      subject: args.subject,
      body: args.body,
      ...(args.cc ? { cc: args.cc } : {}),
    });
    const response = await gmail().users.messages.send({ userId: 'me', requestBody: { raw } });
    return text(`Sent to ${args.to} (id ${response.data.id}): "${args.subject}"`);
  }),
);

const modifyLabels = tool(
  'modify_email_labels',
  'Add or remove Gmail labels on a message. Use label id "UNREAD" to mark read, "TRASH" to bin it.',
  {
    message_id: z.string(),
    add: z.array(z.string()).default([]).describe('Label ids to add.'),
    remove: z.array(z.string()).default([]).describe('Label ids to remove.'),
  },
  guarded('modify_email_labels', async (args) => {
    if (args.add.length === 0 && args.remove.length === 0) {
      return fail('Nothing to do: both add and remove were empty.');
    }
    await gmail().users.messages.modify({
      userId: 'me',
      id: args.message_id,
      requestBody: { addLabelIds: args.add, removeLabelIds: args.remove },
    });
    return text(`Updated labels on ${args.message_id} (+${args.add.join(',')} -${args.remove.join(',')})`);
  }),
);

export const googleServer = createSdkMcpServer({
  name: 'google',
  version: '1.0.0',
  instructions:
    'Gmail and Google Calendar for the user. Read freely; drafting is preferred over sending.',
  tools: [
    listCalendarEvents,
    createCalendarEvent,
    searchEmail,
    readEmail,
    draftEmail,
    sendEmail,
    modifyLabels,
  ],
});
