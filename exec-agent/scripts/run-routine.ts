/**
 * Run one routine by name and print the result. Used for testing a routine
 * without waiting for its cron slot: `npm run routine -- morning-brief`.
 */
import { ExecAgent } from '../src/agent';
import { findRoutine, ROUTINES } from '../src/routines';
import { runRoutine } from '../src/scheduler';
import { CONFIG, telegramConfigured } from '../src/config';
import { TelegramBot } from '../src/surfaces/telegram';

async function main(): Promise<void> {
  const name = process.argv[2];
  const routine = name ? findRoutine(name) : undefined;

  if (!routine) {
    console.error(`Usage: npm run routine -- <name>\n\nAvailable: ${ROUTINES.map((r) => r.name).join(', ')}`);
    process.exit(1);
  }

  const bot = telegramConfigured
    ? new TelegramBot(CONFIG.telegram.token as string, CONFIG.telegram.ownerChatId as string)
    : undefined;

  // Approval replies arrive as Telegram callbacks, which only get dispatched
  // while the bot is polling. Don't run this while the daemon is also running:
  // both would compete for the same update stream.
  bot?.start(async () => undefined);

  const agent = new ExecAgent(
    bot ? (summary) => bot.ask(summary, ['approve', 'deny']) : undefined,
  );

  await runRoutine(agent, routine, async (_, body) => {
    console.log(`\n${body}\n`);
    if (bot) await bot.send(`*${routine.name}*\n\n${body}`);
  });

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
