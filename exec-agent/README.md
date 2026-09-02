# exec-agent

A personal executive assistant that runs as a background daemon on your Mac and
that you talk to from your phone.

It is not a chatbot with your calendar bolted on. It keeps its own task list and
long-term memory, reads your mail and calendar, watches your App Store numbers,
and wakes up on a schedule to brief you — and it asks permission before doing
anything it cannot take back.

```
   your phone ──┐
   (Telegram)   │
                ▼
        ┌───────────────┐      ┌────────────────────────┐
        │  exec-agent   │◄────►│  Claude Agent SDK      │
        │   (launchd)   │      │  (the agent loop)      │
        └───────┬───────┘      └────────────────────────┘
                │
                ├── assistant  → tasks, memory, briefing archive
                ├── google     → Gmail + Calendar
                ├── appstore   → sales, reviews
                └── built-ins  → web search, web fetch, file reads
```

Everything personal — memory, tasks, tokens, logs — lives in `~/.exec-agent/`,
never in this repo.

## Setup

### 1. Prerequisites

Node 20+, and Claude credentials. Either export an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

or run `claude login` once to use your Claude subscription. The Agent SDK picks
up either automatically.

```bash
cd exec-agent
npm install
cp .env.example .env
```

### 2. Telegram (your phone)

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the
   prompts, and copy the token into `TELEGRAM_BOT_TOKEN` in `.env`.
2. Send your new bot any message.
3. Run `npm run whoami` and put the chat id it prints into
   `TELEGRAM_OWNER_CHAT_ID`.

That chat id is the entire access control story — the bot ignores everyone else.

### 3. Gmail + Calendar

In a [Google Cloud project](https://console.cloud.google.com/): enable the Gmail
API and the Calendar API, create an OAuth client of type **Desktop app**, and put
the client id and secret in `.env`. Then:

```bash
npm run auth:google
```

This opens a consent flow and stores a refresh token in
`~/.exec-agent/credentials/google.json`.

### 4. App Store Connect (optional)

App Store Connect → Users and Access → Integrations → App Store Connect API.
Generate a key, download the `.p8` **once**, and set `ASC_KEY_ID`,
`ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH` and `ASC_VENDOR_NUMBER`.

Keep the `.p8` outside this repo — `~/.exec-agent/credentials/` is the natural
home for it.

### 5. Tell it who you are

Write `~/.exec-agent/PROFILE.md`: who you are, what you're building, who matters,
how you like to be handled. It is loaded into the system prompt every session,
and it is the single highest-leverage thing you can do for reply quality.

```markdown
I'm an indie iOS developer. I ship GrillMaster and The Examined Day.
Mornings are for building; I batch email in the afternoon.
Don't draft replies to App Review — flag those and I'll write them myself.
```

## Running it

Try it locally first:

```bash
npm run cli
```

Then install it as a background service that starts at login and restarts if it
crashes:

```bash
npm run install:daemon
```

```bash
launchctl print gui/$UID/com.execagent | head -20   # status
tail -f ~/.exec-agent/logs/daemon.err.log           # logs
launchctl bootout gui/$UID/com.execagent            # stop
```

## Using it

Talk to it normally — that's the main interface. Plus:

| Command | What it does |
|---|---|
| `/morning-brief` | Schedule, mail that matters, tasks due, app numbers |
| `/inbox-triage` | Sorts unread mail, drafts the obvious replies |
| `/evening-review` | What closed, what slipped, what tomorrow looks like |
| `/weekly-research` | Market scan around your apps, with sources |
| `/reset` | Drops conversation history (memory and tasks are kept) |
| `/help` | The list |

The same routines run on a schedule, set by the `CRON_*` values in `.env` and
evaluated in `EXEC_AGENT_TIMEZONE`. Blank out a value to disable that routine.
Defaults: brief at 7:30am weekdays, triage at noon and 5pm weekdays, review at
9pm daily, research Monday 9am.

Test one without waiting for its slot:

```bash
npm run routine -- morning-brief
```

(Stop the daemon first — both would compete for the same Telegram updates.)

## What it can do without asking

Reading is free. Anything irreversible stops and asks you first, as a Telegram
message with Approve / Deny buttons.

| Runs automatically | Asks first |
|---|---|
| Read mail, search mail | **Send** an email |
| Read calendar | **Create** a calendar event |
| Save a Gmail **draft** | Change mail labels / trash |
| Tasks, memory, briefings | Anything else not on the left |
| Web search and fetch | |
| App Store sales and reviews | |

Three properties worth knowing:

- **A timeout is a denial.** If you don't answer within five minutes, the action
  is refused. An agent acting while you're asleep should fail closed.
- **A denial is final.** The agent is instructed not to retry a denied action or
  reach the same effect another way, and it's told so in the refusal itself.
- **No shell by default.** `Bash`, `Write` and `Edit` aren't in the agent's
  context at all. Set `EXEC_AGENT_ENABLE_SHELL=true` to add `Bash` — only worth
  it if you want it doing real work on your machine, and it widens the blast
  radius considerably.

On startup the SDK logs a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning listing the
auto-approved tools. That's expected: it's confirming the left-hand column above
bypasses the approval callback by design.

## Memory

Two files you can open and edit by hand:

- `~/.exec-agent/tasks.json` — commitments, with due dates and projects
- `~/.exec-agent/memory.json` — durable facts, tagged and categorised

The agent is told to write to both without being asked: anything it learns that
matters next week goes into memory, and any commitment either of you makes
becomes a task. Recall is keyword-based and every term must match, which keeps
multi-word lookups honest.

Briefings are archived as dated markdown in `~/.exec-agent/briefings/`.

## Development

```bash
npm test        # stores, chunking, routine wiring — no credentials or API calls
npm run typecheck
npm run dev     # daemon with reload on change
```

Layout:

```
src/
  agent.ts            the Claude Agent SDK wrapper: prompt, sessions, approvals
  routines.ts         the scheduled prompts
  scheduler.ts        cron registration
  surfaces/           telegram.ts (phone), cli.ts (local)
  tools/              assistant.ts, google.ts, appstore.ts — MCP tool servers
  store/              tasks.ts, memory.ts, json-store.ts
```

To add a capability, write a tool in `src/tools/`, add it to a server's `tools`
array, and decide whether it belongs in `AUTO_APPROVED` in `src/agent.ts`. If
it's irreversible, leave it out and it will route through the approval gate.

## Limits

- It only runs while the Mac is awake. Messages sent while it's asleep are
  delivered by Telegram when it wakes, but scheduled routines missed in the
  meantime don't backfill.
- Gmail and Calendar are tested against the API shapes, not against a live
  account in CI — first run is where you'll find any account-specific surprises.
- Telegram messages are encrypted in transit but readable by Telegram. If that
  matters for your mail, use the local CLI instead.
