/**
 * Prints the chat id of whoever last messaged the bot, for TELEGRAM_OWNER_CHAT_ID.
 */
import { CONFIG } from '../src/config';

async function main(): Promise<void> {
  if (!CONFIG.telegram.token) {
    console.error('Set TELEGRAM_BOT_TOKEN in .env first.');
    process.exit(1);
  }

  const response = await fetch(`https://api.telegram.org/bot${CONFIG.telegram.token}/getUpdates`);
  const payload = (await response.json()) as {
    ok: boolean;
    description?: string;
    result?: Array<{ message?: { chat: { id: number; first_name?: string; username?: string } } }>;
  };

  if (!payload.ok) {
    console.error(`Telegram rejected the token: ${payload.description}`);
    process.exit(1);
  }

  const chats = new Map<number, string>();
  for (const update of payload.result ?? []) {
    const chat = update.message?.chat;
    if (chat) chats.set(chat.id, chat.username ?? chat.first_name ?? '(no name)');
  }

  if (chats.size === 0) {
    console.log('No messages yet. Send your bot any message in Telegram, then run this again.');
    return;
  }

  console.log('Chat ids that have messaged this bot:\n');
  for (const [id, name] of chats) console.log(`  ${id}  ${name}`);
  console.log('\nPut the one that is you into TELEGRAM_OWNER_CHAT_ID in .env.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
