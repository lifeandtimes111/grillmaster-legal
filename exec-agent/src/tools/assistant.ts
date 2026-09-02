import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS, todayLocal } from '../config';
import { addTask, listTasks, setTaskStatus, tasksCompletedSince, type Task } from '../store/tasks';
import { remember, recall, listMemory, forget } from '../store/memory';
import { text, fail, guarded } from './helpers';

function renderTask(task: Task): string {
  const bits = [`[${task.id}] ${task.title}`];
  if (task.due) bits.push(`(due ${task.due})`);
  if (task.project) bits.push(`{${task.project}}`);
  if (task.notes) bits.push(`— ${task.notes}`);
  return bits.join(' ');
}

const addTaskTool = tool(
  'add_task',
  'Record a commitment or to-do so it survives past this conversation. ' +
    'Capture anything the user says they will do, or that you agree to do for them.',
  {
    title: z.string().describe('Short imperative description of the task.'),
    notes: z.string().default('').describe('Any detail needed to actually do it later.'),
    due: z.string().default('').describe('Due date as YYYY-MM-DD, or empty if undated.'),
    project: z.string().default('').describe('Grouping label, e.g. "GrillMaster" or "personal".'),
  },
  guarded('add_task', async (args) => {
    if (args.due && !/^\d{4}-\d{2}-\d{2}$/.test(args.due)) {
      return fail(`due must be YYYY-MM-DD, got "${args.due}".`);
    }
    const task = addTask({
      title: args.title,
      ...(args.notes ? { notes: args.notes } : {}),
      ...(args.due ? { due: args.due } : {}),
      ...(args.project ? { project: args.project } : {}),
    });
    return text(`Added ${renderTask(task)}`);
  }),
);

const listTasksTool = tool(
  'list_tasks',
  'List tracked tasks. Check this before answering anything about what is outstanding.',
  {
    status: z.enum(['open', 'done', 'dropped']).default('open'),
    project: z.string().default('').describe('Filter to one project, or empty for all.'),
  },
  guarded('list_tasks', async (args) => {
    const tasks = listTasks({
      status: args.status,
      ...(args.project ? { project: args.project } : {}),
    });
    if (tasks.length === 0) return text(`No ${args.status} tasks.`);
    return text(tasks.map(renderTask).join('\n'));
  }),
  { annotations: { readOnlyHint: true } },
);

const completeTaskTool = tool(
  'complete_task',
  'Mark a task done, or drop it if it is no longer relevant.',
  {
    task_id: z.string().describe('Task id from list_tasks.'),
    status: z.enum(['done', 'dropped']).default('done'),
  },
  guarded('complete_task', async (args) => {
    const task = setTaskStatus(args.task_id, args.status);
    if (!task) return fail(`No task with id ${args.task_id}.`);
    return text(`Marked ${args.status}: ${task.title}`);
  }),
);

const completedSinceTool = tool(
  'tasks_completed_since',
  'List tasks completed on or after a date. Use this to write the evening or weekly review.',
  { since: z.string().describe('ISO date, e.g. 2026-09-01.') },
  guarded('tasks_completed_since', async (args) => {
    const tasks = tasksCompletedSince(args.since);
    if (tasks.length === 0) return text(`Nothing completed since ${args.since}.`);
    return text(tasks.map(renderTask).join('\n'));
  }),
  { annotations: { readOnlyHint: true } },
);

const rememberTool = tool(
  'remember',
  'Store a durable fact about the user, their people, preferences or projects. ' +
    'Use this whenever you learn something that would be useful next week, not just now.',
  {
    category: z
      .enum(['person', 'preference', 'project', 'commitment', 'context'])
      .describe('What kind of fact this is.'),
    content: z.string().describe('The fact, written so it makes sense with no other context.'),
    tags: z.array(z.string()).default([]).describe('Keywords to help recall it later.'),
  },
  guarded('remember', async (args) => {
    const entry = remember({ category: args.category, content: args.content, tags: args.tags });
    return text(`Remembered [${entry.id}] (${entry.category}): ${entry.content}`);
  }),
);

const recallTool = tool(
  'recall',
  'Search long-term memory by keyword. Do this before saying you do not know something about the user.',
  {
    query: z.string().describe('Keywords; every word must appear in a matching entry.'),
    limit: z.number().int().min(1).max(50).default(20),
  },
  guarded('recall', async (args) => {
    const entries = recall(args.query, args.limit);
    if (entries.length === 0) return text(`Nothing in memory matches "${args.query}".`);
    return text(entries.map((entry) => `[${entry.id}] (${entry.category}) ${entry.content}`).join('\n'));
  }),
  { annotations: { readOnlyHint: true } },
);

const listMemoryTool = tool(
  'list_memory',
  'List all stored memory, optionally filtered to one category.',
  {
    category: z
      .enum(['person', 'preference', 'project', 'commitment', 'context', 'all'])
      .default('all'),
  },
  guarded('list_memory', async (args) => {
    const entries = listMemory(args.category === 'all' ? undefined : args.category);
    if (entries.length === 0) return text('Memory is empty.');
    return text(entries.map((entry) => `[${entry.id}] (${entry.category}) ${entry.content}`).join('\n'));
  }),
  { annotations: { readOnlyHint: true } },
);

const forgetTool = tool(
  'forget',
  'Delete one memory entry by id, for when a stored fact has gone stale or wrong.',
  { entry_id: z.string() },
  guarded('forget', async (args) => {
    return forget(args.entry_id)
      ? text(`Forgot ${args.entry_id}.`)
      : fail(`No memory entry with id ${args.entry_id}.`);
  }),
);

const saveBriefingTool = tool(
  'save_briefing',
  'Archive a briefing or review as a dated markdown file, so it can be referred back to later.',
  {
    kind: z.string().describe('Short slug, e.g. "morning-brief" or "weekly-research".'),
    content: z.string().describe('Full markdown body.'),
  },
  guarded('save_briefing', async (args) => {
    const slug = args.kind.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
    const path = join(PATHS.briefings, `${todayLocal()}-${slug}.md`);
    writeFileSync(path, args.content, 'utf8');
    return text(`Saved briefing to ${path}`);
  }),
);

export const assistantServer = createSdkMcpServer({
  name: 'assistant',
  version: '1.0.0',
  instructions:
    "The assistant's own task list, long-term memory and briefing archive. " +
    'These are the only things that persist between conversations.',
  tools: [
    addTaskTool,
    listTasksTool,
    completeTaskTool,
    completedSinceTool,
    rememberTool,
    recallTool,
    listMemoryTool,
    forgetTool,
    saveBriefingTool,
  ],
});
