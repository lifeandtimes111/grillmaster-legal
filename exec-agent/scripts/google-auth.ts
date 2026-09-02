/**
 * One-time Google OAuth. Starts a loopback listener, prints the consent URL,
 * and stores the refresh token in ~/.exec-agent/credentials/google.json.
 */
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { buildOAuthClient, saveGoogleToken, GOOGLE_SCOPES } from '../src/tools/google-client';
import { PATHS } from '../src/config';

async function main(): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const client = buildOAuthClient(redirectUri);
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    // Force the consent screen so Google reliably returns a refresh token,
    // even if this account has authorised the app before.
    prompt: 'consent',
  });

  console.log('\nOpen this URL in your browser and grant access:\n');
  console.log(authUrl);
  console.log('\nWaiting for the redirect…');

  const code = await new Promise<string>((resolve, reject) => {
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectUri);
      const received = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end(received ? 'Authorised. You can close this tab.' : `Authorisation failed: ${error}`);

      if (received) resolve(received);
      else reject(new Error(error ?? 'No code in redirect'));
    });
    setTimeout(() => reject(new Error('Timed out waiting for authorisation')), 5 * 60_000);
  });

  const { tokens } = await client.getToken(code);
  server.close();

  if (!tokens.refresh_token) {
    console.error(
      '\nGoogle did not return a refresh token. Revoke this app at ' +
        'https://myaccount.google.com/permissions and run this again.',
    );
    process.exit(1);
  }

  saveGoogleToken(tokens);
  console.log(`\nSaved to ${PATHS.googleToken}. Gmail and Calendar are connected.`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
