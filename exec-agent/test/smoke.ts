import { addTask, listTasks, setTaskStatus, tasksCompletedSince } from '../src/store/tasks';
import { remember, recall, listMemory, forget } from '../src/store/memory';
import { splitMessage } from '../src/surfaces/telegram';
import { assistantServer } from '../src/tools/assistant';
import { googleServer } from '../src/tools/google';
import { appStoreServer } from '../src/tools/appstore';
import { ROUTINES, findRoutine } from '../src/routines';
import { PATHS, todayLocal } from '../src/config';
import cron from 'node-cron';

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { console.log(`  ok   ${label}`); }
  else { console.log(`  FAIL ${label}`, detail ?? ''); failures++; }
}

console.log(`data dir: ${PATHS.data}`);

console.log('\ntasks:');
const a = addTask({ title: 'Ship the thing', due: '2026-09-10', project: 'GrillMaster' });
const b = addTask({ title: 'Undated thing' });
const c = addTask({ title: 'Sooner', due: '2026-09-03' });
const open = listTasks();
check('three open tasks', open.length === 3, open.length);
check('dated sort before undated, soonest first', open[0]?.id === c.id && open[2]?.id === b.id, open.map(t => t.title));
check('project filter', listTasks({ status: 'open', project: 'GrillMaster' }).length === 1);
setTaskStatus(a.id, 'done');
check('completing removes from open', listTasks().length === 2);
check('completed shows in since-query', tasksCompletedSince(todayLocal()).length === 1);
check('unknown id returns undefined', setTaskStatus('nope', 'done') === undefined);

console.log('\nmemory:');
const m = remember({ category: 'person', content: 'Dana runs QA for the grill app', tags: ['dana', 'qa'] });
remember({ category: 'preference', content: 'Prefers short replies on the phone' });
check('all terms must match', recall('dana qa').length === 1);
check('non-matching multi-term recall is empty', recall('dana accounting').length === 0);
check('category filter', listMemory('preference').length === 1);
check('forget removes', forget(m.id) && recall('dana qa').length === 0);
check('forget on missing id is false', forget('nope') === false);

console.log('\ntelegram chunking:');
check('short passes through', splitMessage('hello').length === 1);
const long = Array.from({ length: 400 }, (_, i) => `line ${i} of some text`).join('\n');
const chunks = splitMessage(long);
check('long message split', chunks.length > 1, chunks.length);
check('every chunk within limit', chunks.every(chunk => chunk.length <= 4096), chunks.map(c => c.length));
const noBreaks = 'x'.repeat(10000);
check('unbreakable text still splits', splitMessage(noBreaks).every(c => c.length <= 4096));

console.log('\nmcp servers + routines:');
check('assistant server built', Boolean(assistantServer));
check('google server built', Boolean(googleServer));
check('appstore server built', Boolean(appStoreServer));
check('four routines', ROUTINES.length === 4, ROUTINES.map(r => r.name));
check('findRoutine works', findRoutine('morning-brief')?.name === 'morning-brief');
check('default crons are valid', ROUTINES.every(r => !r.cron || cron.validate(r.cron)));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
