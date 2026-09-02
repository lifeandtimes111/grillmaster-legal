import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store';
import { PATHS } from '../config';

export type TaskStatus = 'open' | 'done' | 'dropped';

export interface Task {
  id: string;
  title: string;
  notes?: string;
  /** ISO date (YYYY-MM-DD) the task is due, if any. */
  due?: string;
  project?: string;
  status: TaskStatus;
  createdAt: string;
  completedAt?: string;
}

interface TaskFile {
  tasks: Task[];
}

const store = new JsonStore<TaskFile>(PATHS.tasks, () => ({ tasks: [] }));

export function addTask(input: {
  title: string;
  notes?: string;
  due?: string;
  project?: string;
}): Task {
  const task: Task = {
    id: randomUUID().slice(0, 8),
    title: input.title,
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.due ? { due: input.due } : {}),
    ...(input.project ? { project: input.project } : {}),
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  store.update((current) => ({ next: { tasks: [...current.tasks, task] }, result: null }));
  return task;
}

export function listTasks(filter?: { status?: TaskStatus; project?: string }): Task[] {
  const status = filter?.status ?? 'open';
  return store
    .read()
    .tasks.filter((task) => task.status === status)
    .filter((task) => !filter?.project || task.project === filter.project)
    .sort((a, b) => {
      // Dated tasks first, soonest first; undated tasks keep insertion order.
      if (a.due && b.due) return a.due.localeCompare(b.due);
      if (a.due) return -1;
      if (b.due) return 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
}

export function setTaskStatus(id: string, status: TaskStatus): Task | undefined {
  return store.update((current) => {
    const task = current.tasks.find((candidate) => candidate.id === id);
    if (!task) return { next: current, result: undefined };

    const updated: Task = {
      ...task,
      status,
      ...(status === 'done' ? { completedAt: new Date().toISOString() } : {}),
    };
    return {
      next: { tasks: current.tasks.map((candidate) => (candidate.id === id ? updated : candidate)) },
      result: updated,
    };
  });
}

/** Tasks completed on or after the given ISO date, for the evening review. */
export function tasksCompletedSince(isoDate: string): Task[] {
  return store
    .read()
    .tasks.filter((task) => task.status === 'done' && (task.completedAt ?? '') >= isoDate);
}
