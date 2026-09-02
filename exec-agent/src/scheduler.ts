import cron from 'node-cron';
import { CONFIG } from './config';
import { ROUTINES, type Routine } from './routines';
import type { ExecAgent } from './agent';
import { createLogger } from './logger';

const log = createLogger('scheduler');

/**
 * Register every routine that has a cron expression. Delivery is injected so
 * routines can go to Telegram in the daemon and to stdout when run by hand.
 */
export function startScheduler(
  agent: ExecAgent,
  deliver: (routine: Routine, body: string) => Promise<void>,
): void {
  for (const routine of ROUTINES) {
    if (!routine.cron) {
      log.info(`Routine "${routine.name}" has no schedule; manual only`);
      continue;
    }
    if (!cron.validate(routine.cron)) {
      log.error(`Routine "${routine.name}" has an invalid cron expression, skipping`, routine.cron);
      continue;
    }

    cron.schedule(routine.cron, () => void runRoutine(agent, routine, deliver), {
      timezone: CONFIG.timezone,
    });
    log.info(`Scheduled "${routine.name}" at "${routine.cron}" (${CONFIG.timezone})`);
  }
}

export async function runRoutine(
  agent: ExecAgent,
  routine: Routine,
  deliver: (routine: Routine, body: string) => Promise<void>,
): Promise<void> {
  log.info(`Running routine "${routine.name}"`);
  try {
    const body = await agent.ask(routine.prompt, routine.conversationKey);
    await deliver(routine, body);
  } catch (error) {
    log.error(`Routine "${routine.name}" failed`, error);
    // A failed routine should still say something, or it fails silently forever.
    await deliver(routine, `⚠️ ${routine.name} failed: ${error instanceof Error ? error.message : String(error)}`).catch(
      () => undefined,
    );
  }
}
