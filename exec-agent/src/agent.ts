import { query, type Options, type PermissionResult, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG, PATHS, nowLocal, todayLocal, googleConfigured, appStoreConfigured } from './config';
import { JsonStore } from './store/json-store';
import { assistantServer } from './tools/assistant';
import { googleServer } from './tools/google';
import { appStoreServer } from './tools/appstore';
import { createLogger } from './logger';

const log = createLogger('agent');

/**
 * Tools that only read, or that write somewhere reversible and private. These
 * run without asking, or the assistant would be useless while the user sleeps.
 */
const AUTO_APPROVED = [
  'mcp__assistant__*',
  'mcp__google__list_calendar_events',
  'mcp__google__search_email',
  'mcp__google__read_email',
  'mcp__google__draft_email',
  'mcp__appstore__*',
  'WebSearch',
  'WebFetch',
  'Read',
  'Glob',
  'Grep',
];

/**
 * Built-ins the agent can see at all. Everything outside this list — Bash,
 * Write, Edit — is kept out of context so the model never reaches for it.
 * Shell access is opt-in because this process runs unattended.
 */
const BUILT_INS = process.env.EXEC_AGENT_ENABLE_SHELL === 'true'
  ? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Bash']
  : ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];

/** Answering an approval prompt: resolves to 'approve' or anything else to deny. */
export type Approver = (summary: string) => Promise<string>;

interface SessionFile {
  sessions: Record<string, string>;
}

const sessionStore = new JsonStore<SessionFile>(PATHS.sessions, () => ({ sessions: {} }));

function systemPrompt(): string {
  const profile = existsSync(PATHS.profile) ? readFileSync(PATHS.profile, 'utf8').trim() : '';

  return [
    'You are the executive assistant for one person. You run continuously on their Mac and they',
    'reach you from their phone, so most of your replies are read on a small screen while they are',
    'doing something else.',
    '',
    `Right now it is ${nowLocal()} (${CONFIG.timezone}). Today is ${todayLocal()}.`,
    '',
    '## How you work',
    '',
    '- Answer the question that was asked. Lead with the answer, then the detail that changes what',
    '  they do next. No preamble, no restating the request, no closing offers of further help.',
    '- Default to a few sentences. Use short bullets for lists of things. Reserve headings for',
    '  scheduled briefings, which are read in full.',
    '- You are talking to one specific person, not writing a report about them. Say "you", not',
    '  "the user".',
    '- When something is genuinely ambiguous and the readings lead somewhere different, ask one',
    '  short question. Otherwise pick the sensible reading, act, and say what you assumed.',
    '',
    '## Memory is the job',
    '',
    'Conversations end; the stores are what persist. Treat them as your actual working memory.',
    '',
    '- Whenever you learn something durable — a person and who they are, a preference, a project,',
    '  a deadline, a decision — call `remember`. Do this without being asked.',
    '- Before saying you do not know something about them, call `recall`.',
    '- Whenever either of you commits to doing something, call `add_task`. A commitment that only',
    '  exists in a chat message is a commitment you have dropped.',
    '- Check `list_tasks` before answering anything about what is outstanding.',
    '',
    '## Acting on their behalf',
    '',
    '- Reading their mail, calendar and App Store data is free — do it whenever it would make an',
    '  answer concrete rather than speculative.',
    '- Prefer `draft_email` over `send_email`. Draft by default; send only when they asked you to',
    '  send, in this conversation, in so many words.',
    '- Sending mail, creating calendar events and changing labels ask them for approval first.',
    '  If an approval is denied or times out, say so plainly and stop — do not look for another',
    '  route to the same effect.',
    '- Never invent a fact about their schedule, mail or numbers. Look it up, or say you could not.',
    '',
    ...(profile
      ? ['## About them', '', profile, '']
      : [
          '## About them',
          '',
          `No profile yet. Write one to ${PATHS.profile} — who they are, what they are working on,`,
          'who matters, how they like to be handled — and it will be loaded here every session.',
          '',
        ]),
  ].join('\n');
}

function mcpServers() {
  return {
    assistant: assistantServer,
    ...(googleConfigured ? { google: googleServer } : {}),
    ...(appStoreConfigured ? { appstore: appStoreServer } : {}),
  };
}

function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  const short = toolName.replace(/^mcp__[a-z]+__/, '');
  const detail = Object.entries(input)
    .filter(([, value]) => value !== '' && value !== undefined && value !== null)
    .map(([key, value]) => {
      const rendered = typeof value === 'string' ? value : JSON.stringify(value);
      return `${key}: ${rendered.length > 300 ? `${rendered.slice(0, 300)}…` : rendered}`;
    })
    .join('\n');

  return `🔐 Approve *${short}*?\n\n${detail}`;
}

export class ExecAgent {
  constructor(private readonly approver?: Approver) {}

  private permissionGate = async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (!this.approver) {
      return {
        behavior: 'deny',
        message:
          `${toolName} needs approval, but no approval channel is connected right now. ` +
          'Tell the user what you wanted to do and let them decide.',
      };
    }

    log.info('Requesting approval', { toolName });
    const choice = await this.approver(describeToolCall(toolName, input));

    if (choice === 'approve') {
      log.info('Approved', { toolName });
      return { behavior: 'allow', updatedInput: input };
    }

    log.info('Denied', { toolName, choice });
    return {
      behavior: 'deny',
      message: `The user declined ${toolName}. Do not retry it or attempt the same effect another way.`,
    };
  };

  private buildOptions(conversationKey: string, resume: string | undefined): Options {
    const options: Options = {
      model: CONFIG.model,
      systemPrompt: systemPrompt(),
      mcpServers: mcpServers(),
      allowedTools: AUTO_APPROVED,
      tools: BUILT_INS,
      canUseTool: this.permissionGate,
      permissionMode: 'default',
      // Don't inherit whatever Claude Code settings happen to be on this Mac;
      // a daemon should behave the same on every machine.
      settingSources: [],
      cwd: PATHS.data,
      maxTurns: 40,
      ...(resume ? { resume } : {}),
    };
    log.debug('Built options', { conversationKey, resume: resume ?? null });
    return options;
  }

  /**
   * Run one prompt to completion and return the assistant's final text.
   * Conversation history is kept per key, so the phone thread and each
   * scheduled routine each have their own continuous session.
   */
  async ask(prompt: string, conversationKey = 'default'): Promise<string> {
    const stored = sessionStore.read().sessions[conversationKey];

    try {
      return await this.run(prompt, conversationKey, stored);
    } catch (error) {
      // A resumed session can be missing if the transcript was cleaned up.
      // Losing history is better than losing the reply, so retry once fresh.
      if (stored) {
        log.warn('Resume failed, starting a fresh session', error);
        this.clearSession(conversationKey);
        return this.run(prompt, conversationKey, undefined);
      }
      throw error;
    }
  }

  private async run(
    prompt: string,
    conversationKey: string,
    resume: string | undefined,
  ): Promise<string> {
    const started = Date.now();
    let finalText = '';
    let sessionId: string | undefined;

    for await (const message of query({
      prompt,
      options: this.buildOptions(conversationKey, resume),
    }) as AsyncIterable<SDKMessage>) {
      const candidate = (message as { session_id?: string }).session_id;
      if (candidate) sessionId = candidate;

      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'tool_use') log.debug('Tool call', { name: block.name });
        }
      }

      if (message.type === 'result') {
        if (message.subtype === 'success') {
          finalText = message.result;
        } else {
          log.error('Run ended without a result', { subtype: message.subtype });
          finalText = `I hit an error before finishing (${message.subtype}). The log has the detail.`;
        }
      }
    }

    if (sessionId) {
      sessionStore.update((current) => ({
        next: { sessions: { ...current.sessions, [conversationKey]: sessionId as string } },
        result: null,
      }));
    }

    log.info('Run complete', { conversationKey, ms: Date.now() - started });
    return finalText || 'I finished without producing a reply, which is a bug worth reporting.';
  }

  clearSession(conversationKey = 'default'): void {
    sessionStore.update((current) => {
      const { [conversationKey]: _removed, ...rest } = current.sessions;
      return { next: { sessions: rest }, result: null };
    });
  }
}
