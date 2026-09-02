import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { CONFIG, PATHS } from '../config';

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
];

export interface StoredGoogleToken {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
  token_type?: string | null;
}

export function buildOAuthClient(redirectUri?: string): OAuth2Client {
  if (!CONFIG.google.clientId || !CONFIG.google.clientSecret) {
    throw new Error(
      'Google is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.',
    );
  }
  return new google.auth.OAuth2(CONFIG.google.clientId, CONFIG.google.clientSecret, redirectUri);
}

export function saveGoogleToken(token: StoredGoogleToken): void {
  writeFileSync(PATHS.googleToken, JSON.stringify(token, null, 2), { mode: 0o600 });
}

/**
 * An authorised client built from the refresh token on disk. Refreshed access
 * tokens are written back so a long-lived daemon doesn't re-auth every hour.
 */
export function authorizedClient(): OAuth2Client {
  if (!existsSync(PATHS.googleToken)) {
    throw new Error('Google is not authorised yet. Run `npm run auth:google` once.');
  }
  const token = JSON.parse(readFileSync(PATHS.googleToken, 'utf8')) as StoredGoogleToken;
  const client = buildOAuthClient();
  client.setCredentials(token);

  client.on('tokens', (fresh) => {
    saveGoogleToken({ ...token, ...fresh, refresh_token: fresh.refresh_token ?? token.refresh_token });
  });

  return client;
}

export function gmail() {
  return google.gmail({ version: 'v1', auth: authorizedClient() });
}

export function calendar() {
  return google.calendar({ version: 'v3', auth: authorizedClient() });
}

/**
 * Gmail returns bodies as base64url spread across a MIME tree. Walk it depth
 * first and prefer text/plain, falling back to stripped HTML.
 */
export function extractBody(payload: unknown): string {
  const plain = findPart(payload, 'text/plain');
  if (plain) return plain;

  const html = findPart(payload, 'text/html');
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

function findPart(node: unknown, mimeType: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const part = node as {
    mimeType?: string;
    body?: { data?: string | null };
    parts?: unknown[];
  };

  if (part.mimeType === mimeType && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** Pull a named header out of a Gmail message payload, case-insensitively. */
export function header(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  const match = headers?.find((entry) => entry.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? '';
}

/** RFC 2822 message, base64url encoded, as the Gmail send/draft API wants. */
export function buildRawMessage(input: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  inReplyTo?: string;
}): string {
  const lines = [
    `To: ${input.to}`,
    ...(input.cc ? [`Cc: ${input.cc}`] : []),
    `Subject: ${input.subject}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    input.body,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
