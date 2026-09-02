import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store';
import { PATHS } from '../config';

/**
 * Long-term memory: durable facts the assistant should carry between
 * conversations. Deliberately small and hand-auditable — it is a file you can
 * open and edit, not an opaque vector index.
 */
export interface MemoryEntry {
  id: string;
  /** e.g. "person", "preference", "project", "commitment", "context". */
  category: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemoryFile {
  entries: MemoryEntry[];
}

const store = new JsonStore<MemoryFile>(PATHS.memory, () => ({ entries: [] }));

export function remember(input: {
  category: string;
  content: string;
  tags?: string[];
}): MemoryEntry {
  const now = new Date().toISOString();
  const entry: MemoryEntry = {
    id: randomUUID().slice(0, 8),
    category: input.category,
    content: input.content,
    tags: input.tags ?? [],
    createdAt: now,
    updatedAt: now,
  };
  store.update((current) => ({ next: { entries: [...current.entries, entry] }, result: null }));
  return entry;
}

/**
 * Keyword recall. Every term must appear somewhere in the entry, which keeps
 * multi-word queries from matching on a single common word.
 */
export function recall(query: string, limit = 20): MemoryEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = store.read().entries;
  if (terms.length === 0) return entries.slice(-limit);

  return entries
    .filter((entry) => {
      const haystack = `${entry.category} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .slice(-limit);
}

export function listMemory(category?: string): MemoryEntry[] {
  const entries = store.read().entries;
  return category ? entries.filter((entry) => entry.category === category) : entries;
}

export function forget(id: string): boolean {
  return store.update((current) => {
    const exists = current.entries.some((entry) => entry.id === id);
    return {
      next: { entries: current.entries.filter((entry) => entry.id !== id) },
      result: exists,
    };
  });
}
