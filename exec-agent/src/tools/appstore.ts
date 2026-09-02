import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CONFIG } from '../config';
import { text, fail, guarded } from './helpers';

const API_ROOT = 'https://api.appstoreconnect.apple.com';

/**
 * App Store Connect wants a short-lived ES256 JWT per request window. Apple
 * caps the lifetime at 20 minutes; we mint a fresh one each call, which is
 * cheap and avoids caching an expired token.
 */
function bearerToken(): string {
  const { keyId, issuerId, privateKeyPath } = CONFIG.appStore;
  if (!keyId || !issuerId || !privateKeyPath) {
    throw new Error(
      'App Store Connect is not configured. Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY_PATH.',
    );
  }
  const privateKey = readFileSync(privateKeyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    { iss: issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: keyId, typ: 'JWT' } },
  );
}

async function ascFetch(path: string): Promise<Response> {
  return fetch(`${API_ROOT}${path}`, {
    headers: { Authorization: `Bearer ${bearerToken()}` },
  });
}

const listApps = tool(
  'list_apps',
  'List the apps in this App Store Connect account, with their ids. ' +
    'Call this first to resolve an app name to the id other tools need.',
  {},
  guarded('list_apps', async () => {
    const response = await ascFetch('/v1/apps?limit=50');
    if (!response.ok) {
      return fail(`App Store Connect returned ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ id: string; attributes?: { name?: string; sku?: string; bundleId?: string } }>;
    };
    const apps = payload.data ?? [];
    if (apps.length === 0) return text('No apps found on this account.');

    return text(
      apps
        .map((app) => `id: ${app.id} — ${app.attributes?.name ?? '(unnamed)'} (${app.attributes?.bundleId ?? '?'})`)
        .join('\n'),
    );
  }),
  { annotations: { readOnlyHint: true } },
);

const salesReport = tool(
  'sales_report',
  'Daily units sold and downloads across all apps for one date. ' +
    "Apple publishes a day's report about a day later, so 'yesterday' is the freshest reliable date.",
  {
    report_date: z
      .string()
      .default('')
      .describe('Date as YYYY-MM-DD. Empty means yesterday in the user timezone.'),
  },
  guarded('sales_report', async (args) => {
    if (!CONFIG.appStore.vendorNumber) {
      return fail('ASC_VENDOR_NUMBER is not set, which sales reports require.');
    }

    const date =
      args.report_date ||
      new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA', { timeZone: CONFIG.timezone });

    const query = new URLSearchParams({
      'filter[frequency]': 'DAILY',
      'filter[reportDate]': date,
      'filter[reportSubType]': 'SUMMARY',
      'filter[reportType]': 'SALES',
      'filter[vendorNumber]': CONFIG.appStore.vendorNumber,
    });

    const response = await ascFetch(`/v1/salesReports?${query.toString()}`);
    if (response.status === 404) {
      return text(`No sales report published yet for ${date}. Apple usually posts it a day later.`);
    }
    if (!response.ok) {
      return fail(`Sales report request returned ${response.status}: ${await response.text()}`);
    }

    // The endpoint returns a gzipped, tab-separated report.
    const tsv = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
    const rows = tsv.trim().split('\n');
    const headerRow = rows[0];
    if (!headerRow || rows.length < 2) return text(`Report for ${date} is empty (no sales).`);

    const columns = headerRow.split('\t');
    const indexOf = (name: string) => columns.findIndex((column) => column.trim() === name);
    const titleIndex = indexOf('Title');
    const unitsIndex = indexOf('Units');
    const typeIndex = indexOf('Product Type Identifier');
    const countryIndex = indexOf('Country Code');

    if (titleIndex < 0 || unitsIndex < 0) {
      return fail(`Unexpected report layout. Columns were: ${columns.join(', ')}`);
    }

    const byApp = new Map<string, number>();
    const byCountry = new Map<string, number>();
    let inAppPurchases = 0;

    for (const row of rows.slice(1)) {
      const cells = row.split('\t');
      const title = cells[titleIndex]?.trim() ?? '(unknown)';
      const units = Number.parseInt(cells[unitsIndex] ?? '0', 10) || 0;
      const productType = typeIndex >= 0 ? (cells[typeIndex]?.trim() ?? '') : '';

      // Apple's product type identifiers for in-app purchases start with "IA".
      if (productType.startsWith('IA')) inAppPurchases += units;

      byApp.set(title, (byApp.get(title) ?? 0) + units);
      if (countryIndex >= 0) {
        const country = cells[countryIndex]?.trim() ?? '??';
        byCountry.set(country, (byCountry.get(country) ?? 0) + units);
      }
    }

    const total = [...byApp.values()].reduce((sum, units) => sum + units, 0);
    const topCountries = [...byCountry.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([country, units]) => `${country} ${units}`)
      .join(', ');

    return text(
      [
        `Sales for ${date} — ${total} units total, ${inAppPurchases} of them in-app purchases.`,
        '',
        ...[...byApp.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([title, units]) => `- ${title}: ${units}`),
        ...(topCountries ? ['', `Top countries: ${topCountries}`] : []),
      ].join('\n'),
    );
  }),
  { annotations: { readOnlyHint: true } },
);

const customerReviews = tool(
  'customer_reviews',
  'Recent App Store customer reviews for one app, newest first. Use list_apps to get the app id.',
  {
    app_id: z.string().describe('Numeric App Store Connect app id.'),
    limit: z.number().int().min(1).max(50).default(10),
  },
  guarded('customer_reviews', async (args) => {
    const response = await ascFetch(
      `/v1/apps/${args.app_id}/customerReviews?sort=-createdDate&limit=${args.limit}`,
    );
    if (!response.ok) {
      return fail(`Reviews request returned ${response.status}: ${await response.text()}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{
        attributes?: {
          rating?: number;
          title?: string;
          body?: string;
          reviewerNickname?: string;
          createdDate?: string;
          territory?: string;
        };
      }>;
    };
    const reviews = payload.data ?? [];
    if (reviews.length === 0) return text('No reviews returned.');

    return text(
      reviews
        .map((review) => {
          const attributes = review.attributes ?? {};
          const stars = '★'.repeat(attributes.rating ?? 0).padEnd(5, '☆');
          const date = attributes.createdDate?.slice(0, 10) ?? '?';
          return [
            `${stars} ${date} ${attributes.territory ?? ''} — ${attributes.title ?? '(no title)'}`,
            `  by ${attributes.reviewerNickname ?? 'anonymous'}: ${attributes.body ?? ''}`,
          ].join('\n');
        })
        .join('\n\n'),
    );
  }),
  { annotations: { readOnlyHint: true } },
);

export const appStoreServer = createSdkMcpServer({
  name: 'appstore',
  version: '1.0.0',
  instructions: "Read-only access to the user's App Store Connect account: apps, sales, reviews.",
  tools: [listApps, salesReport, customerReviews],
});
