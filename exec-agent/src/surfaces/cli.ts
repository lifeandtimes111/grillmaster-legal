import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { ExecAgent } from '../agent';
import { findRoutine, ROUTINES } from '../routines';
import { runRoutine } from '../scheduler';

/**
 * A local REPL for talking to the assistant without Telegram. Useful for
 * setting it up, and for checking a change before restarting the daemon.
 */
async function main(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });

  // On the CLI the human is right here, so approvals prompt on stdin.
  const agent = new ExecAgent(async (summary) => {
    const answer = await rl.question(`\n${summary}\n\napprove / deny > `);
    return answer.trim().toLowerCase().startsWith('a') ? 'approve' : 'deny';
  });

  stdout.write(
    ['Executive assistant — local console.', 'Commands: /reset, /exit, ' + ROUTINES.map((r) => `/${r.name}`).join(', '), ''].join('\n') + '\n',
  );

  for (;;) {
    const line = (await rl.question('\nyou > ')).trim();
    if (!line) continue;
    if (line === '/exit' || line === '/quit') break;

    if (line === '/reset') {
      agent.clearSession('cli');
      stdout.write('History dropped.\n');
      continue;
    }

    const routine = line.startsWith('/') ? findRoutine(line.slice(1)) : undefined;
    if (routine) {
      await runRoutine(agent, routine, async (_, body) => {
        stdout.write(`\n${body}\n`);
      });
      continue;
    }

    try {
      const reply = await agent.ask(line, 'cli');
      stdout.write(`\n${reply}\n`);
    } catch (error) {
      stdout.write(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
