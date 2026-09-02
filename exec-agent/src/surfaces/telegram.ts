import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger';

const log = createLogger('telegram');
const MAX_MESSAGE_LENGTH = 4096;

interface TelegramUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string; from?: { id: number } };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number };
    message?: { chat: { id: number }; message_id: number };
  };
}

interface PendingApproval {
  resolve: (choice: string) => void;
  timer: NodeJS.Timeout;
  chatId: number;
  messageId?: number;
  prompt: string;
}

export class TelegramBot {
  private offset = 0;
  private running = false;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly token: string,
    private readonly ownerChatId: string,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!payload.ok) throw new Error(`Telegram ${method} failed: ${payload.description}`);
    return payload.result as T;
  }

  /**
   * Send text to the owner, split across messages if needed. Telegram's legacy
   * Markdown parser rejects unbalanced characters that appear routinely in
   * model output, so a parse failure falls back to plain text rather than
   * dropping the message.
   */
  async send(body: string, chatId: string | number = this.ownerChatId): Promise<void> {
    for (const chunk of splitMessage(body)) {
      try {
        await this.call('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'Markdown' });
      } catch {
        await this.call('sendMessage', { chat_id: chatId, text: chunk });
      }
    }
  }

  async sendTyping(chatId: string | number = this.ownerChatId): Promise<void> {
    try {
      await this.call('sendChatAction', { chat_id: chatId, action: 'typing' });
    } catch {
      // Cosmetic only.
    }
  }

  /**
   * Ask the owner to approve an action, and block until they answer or the
   * timeout expires. A timeout resolves to "deny" — the safe default for an
   * agent acting while nobody is watching.
   */
  async ask(prompt: string, choices: string[], timeoutMs = 5 * 60_000): Promise<string> {
    const key = randomUUID().slice(0, 8);

    const sent = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: this.ownerChatId,
      text: prompt,
      reply_markup: {
        inline_keyboard: [
          choices.map((choice) => ({ text: choice, callback_data: `${key}:${choice}` })),
        ],
      },
    });

    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        void this.call('editMessageText', {
          chat_id: this.ownerChatId,
          message_id: sent.message_id,
          text: `${prompt}\n\n⏱ No answer in time — treated as "deny".`,
        }).catch(() => undefined);
        resolve('deny');
      }, timeoutMs);

      this.pending.set(key, {
        resolve,
        timer,
        chatId: Number(this.ownerChatId),
        messageId: sent.message_id,
        prompt,
      });
    });
  }

  /** Long-poll for updates and hand plain messages to the supplied handler. */
  start(onMessage: (message: string, chatId: number) => Promise<void>): void {
    this.running = true;
    void this.poll(onMessage);
    log.info('Telegram polling started');
  }

  stop(): void {
    this.running = false;
  }

  private async poll(onMessage: (message: string, chatId: number) => Promise<void>): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.call<TelegramUpdate[]>('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query'],
        });

        for (const update of updates) {
          this.offset = update.update_id + 1;
          try {
            await this.dispatch(update, onMessage);
          } catch (error) {
            log.error('Failed handling update', error);
          }
        }
      } catch (error) {
        // Network blips and Telegram 5xx are routine; back off and continue.
        log.warn('Polling error, retrying in 5s', error);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  private async dispatch(
    update: TelegramUpdate,
    onMessage: (message: string, chatId: number) => Promise<void>,
  ): Promise<void> {
    if (update.callback_query) {
      const query = update.callback_query;
      const [key, choice] = (query.data ?? '').split(':');
      await this.call('answerCallbackQuery', { callback_query_id: query.id });

      if (!key || !choice) return;
      const waiting = this.pending.get(key);
      if (!waiting) return;

      clearTimeout(waiting.timer);
      this.pending.delete(key);

      if (waiting.messageId) {
        await this.call('editMessageText', {
          chat_id: waiting.chatId,
          message_id: waiting.messageId,
          text: `${waiting.prompt}\n\n→ ${choice}`,
        }).catch(() => undefined);
      }
      waiting.resolve(choice);
      return;
    }

    const message = update.message;
    const body = message?.text?.trim();
    if (!message || !body) return;

    // Single-user bot: anyone else is ignored outright.
    if (String(message.chat.id) !== this.ownerChatId) {
      log.warn('Ignored message from unauthorised chat', { chatId: message.chat.id });
      return;
    }

    await onMessage(body, message.chat.id);
  }
}

/** Split on paragraph, then line, then hard boundaries to respect Telegram's cap. */
export function splitMessage(body: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (body.length <= limit) return [body];

  const chunks: string[] = [];
  let remaining = body;

  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    const cut = breakAt > limit * 0.5 ? breakAt : limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}
