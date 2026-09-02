import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

/**
 * A tiny durable JSON store. Writes go to a temp file and are renamed into
 * place so a crash mid-write can't leave a truncated file behind.
 */
export class JsonStore<T> {
  constructor(
    private readonly path: string,
    private readonly fallback: () => T,
  ) {}

  read(): T {
    if (!existsSync(this.path)) return this.fallback();
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as T;
    } catch {
      // A corrupt file shouldn't be silently replaced, so keep a copy aside.
      try {
        renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      return this.fallback();
    }
  }

  write(value: T): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  update<R>(mutator: (current: T) => { next: T; result: R }): R {
    const { next, result } = mutator(this.read());
    this.write(next);
    return result;
  }
}
