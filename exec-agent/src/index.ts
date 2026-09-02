import { CONFIG, telegramConfigured, googleConfigured, appStoreConfigured } from './config';
import { ExecAgent } from './agent';
import { TelegramBot } from './surfaces/telegram';
import { startScheduler, runRoutine } from './scheduler';
import { ROUTINES, findRoutine } from './routines';
import { createLogger } from './logger';

const log = createLogger('main');

async function main(): Promise<void> {
  if (!telegramConfigured) {
    console.error(
      'TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_CHAT_ID must both be set before the daemon can run.\n' +
        'See README.md, or use `npm run cli` to talk to the assistant locally without Telegram.',
    );
    process.exit(1);
  }

  const bot = new TelegramBot(CONFIG.telegram.token as string, CONFIG.telegram.ownerChatId as string);
  const agent = new ExecAgent((summary) => bot.ask(summary, ['approve', 'deny']));

  bot.start(async (body, chatId) => {
    const command = body.startsWith('/') ? body.slice(1).split(/\s+/)[0] ?? '' : '';

    if (command === 'help' || command === 'start') {
      await bot.send(helpText(), chatId);
      return;
    }

    if (command === 'reset') {
      agent.clearSession('phone');
      await bot.send('Fresh start — I have dropped the conversation history. Memory and tasks are untouched.', chatId);
      return;
    }

    const routine = command ? findRoutine(command) : undefined;
    if (routine) {
      await bot.send(`Running ${routine.name}…`, chatId);
      await runRoutine(agent, routine, (_, output) => bot.send(output, chatId));
      return;
    }

    // Anything else is a normal turn of conversation.
    const typing = setInterval(() => void bot.sendTyping(chatId), 4000);
    void bot.sendTyping(chatId);
    try {
      const reply = await agent.ask(body, 'phone');
      await bot.send(reply, chatId);
    } catch (error) {
      log.error('Turn failed', error);
      await bot.send(`Something broke: ${error instanceof Error ? error.message : String(error)}`, chatId);
    } finally {
      clearInterval(typing);
    }
  });

  startScheduler(agent, (routine, body) => bot.send(`*${routine.name}*\n\n${body}`));

  const connected = [
    'assistant memory',
    googleConfigured ? 'Gmail + Calendar' : null,
    appStoreConfigured ? 'App Store Connect' : null,
  ].filter(Boolean);

  log.info('Daemon ready', { connected });
  await bot.send(`Assistant online. Connected: ${connected.join(', ')}.\nSend /help for commands.`);

  const shutdown = () => {
    log.info('Shutting down');
    bot.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function helpText(): string {
  return [
    'Just talk to me normally — that is the main interface.',
    '',
    'Commands:',
    ...ROUTINES.map((routine) => `/${routine.name} — ${routine.description}`),
    '/reset — drop the conversation history (memory and tasks are kept)',
    '/help — this list',
  ].join('\n');
}

main().catch((error) => {
  log.error('Fatal', error);
  process.exit(1);
});
