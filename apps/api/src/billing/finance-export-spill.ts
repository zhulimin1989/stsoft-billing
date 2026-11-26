import { createReadStream, createWriteStream } from 'fs';
import { appendFile, mkdtemp, readFile, rm, unlink } from 'fs/promises';
import { once } from 'events';
import { createInterface } from 'readline';
import { join } from 'path';

type ExternalSorterOptions<T> = {
  bufferRows?: number;
  mergeFanIn?: number;
  encode?: (value: T) => string;
  decode?: (value: string) => T;
  mergeEqual?: (left: T, right: T) => T;
};

const DEFAULT_BUFFER_ROWS = 10_000;
const DEFAULT_MERGE_FAN_IN = 32;

/**
 * Sorts arbitrarily large row sets with bounded heap usage. Sorted runs and
 * intermediate merge files live beside the export temp file and are removed
 * by dispose(). Equal rows can optionally be folded while runs are merged.
 */
export class FinanceExportExternalSorter<T> {
  private readonly bufferRows: number;
  private readonly mergeFanIn: number;
  private readonly encode: (value: T) => string;
  private readonly decode: (value: string) => T;
  private readonly mergeEqual?: (left: T, right: T) => T;
  private buffer: T[] = [];
  private runs: string[] = [];
  private workDirectory: string | null = null;
  private sequence = 0;

  constructor(
    private readonly workDirectoryPrefix: string,
    private readonly compare: (left: T, right: T) => number,
    options: ExternalSorterOptions<T> = {},
  ) {
    this.bufferRows = Math.max(1, Math.floor(options.bufferRows ?? DEFAULT_BUFFER_ROWS));
    this.mergeFanIn = Math.max(2, Math.floor(options.mergeFanIn ?? DEFAULT_MERGE_FAN_IN));
    this.encode = options.encode ?? ((value) => JSON.stringify(value));
    this.decode = options.decode ?? ((value) => JSON.parse(value) as T);
    this.mergeEqual = options.mergeEqual;
  }

  async add(rows: readonly T[]): Promise<void> {
    for (const row of rows) {
      this.buffer.push(row);
      if (this.buffer.length >= this.bufferRows) await this.flushBuffer();
    }
  }

  async *batches(batchSize: number): AsyncGenerator<T[]> {
    await this.flushBuffer();
    if (this.runs.length === 0) return;
    await this.collapseRuns();
    const batch: T[] = [];
    for await (const row of this.readRun(this.runs[0])) {
      batch.push(row);
      if (batch.length >= batchSize) yield batch.splice(0, batch.length);
    }
    if (batch.length > 0) yield batch;
  }

  async dispose(): Promise<void> {
    if (!this.workDirectory) return;
    const directory = this.workDirectory;
    this.workDirectory = null;
    this.buffer = [];
    this.runs = [];
    await rm(directory, { recursive: true, force: true });
  }

  private async ensureWorkDirectory(): Promise<string> {
    if (!this.workDirectory) this.workDirectory = await mkdtemp(this.workDirectoryPrefix);
    return this.workDirectory;
  }

  private async flushBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    rows.sort(this.compare);
    const run = await this.nextRunPath();
    await this.writeRun(run, rows, true);
    this.runs.push(run);
  }

  private async collapseRuns(): Promise<void> {
    while (this.runs.length > 1) {
      const nextRuns: string[] = [];
      for (let index = 0; index < this.runs.length; index += this.mergeFanIn) {
        const group = this.runs.slice(index, index + this.mergeFanIn);
        if (group.length === 1) {
          nextRuns.push(group[0]);
          continue;
        }
        const merged = await this.nextRunPath();
        await this.mergeRuns(group, merged);
        await Promise.all(group.map((path) => unlink(path).catch(() => undefined)));
        nextRuns.push(merged);
      }
      this.runs = nextRuns;
    }
  }

  private async mergeRuns(paths: string[], outputPath: string): Promise<void> {
    const iterators = paths.map((path) => this.readRun(path)[Symbol.asyncIterator]());
    const heads = await Promise.all(iterators.map((iterator) => iterator.next()));
    const output = createWriteStream(outputPath, { flags: 'w', encoding: 'utf8' });
    let pending: T | undefined;
    try {
      for (;;) {
        let selected = -1;
        for (let index = 0; index < heads.length; index += 1) {
          if (heads[index].done) continue;
          if (
            selected === -1
            || this.compare(heads[index].value, heads[selected].value) < 0
          ) {
            selected = index;
          }
        }
        if (selected === -1) break;
        const value = heads[selected].value;
        heads[selected] = await iterators[selected].next();
        if (this.mergeEqual && pending !== undefined && this.compare(pending, value) === 0) {
          pending = this.mergeEqual(pending, value);
          continue;
        }
        if (pending !== undefined) await this.writeLine(output, this.encode(pending));
        pending = value;
      }
      if (pending !== undefined) await this.writeLine(output, this.encode(pending));
      const finished = once(output, 'finish');
      output.end();
      await finished;
    } catch (error) {
      output.destroy();
      throw error;
    } finally {
      await Promise.all(iterators.map((iterator) => iterator.return?.(undefined)));
    }
  }

  private async writeRun(path: string, rows: T[], foldEqual: boolean): Promise<void> {
    const output = createWriteStream(path, { flags: 'w', encoding: 'utf8' });
    let pending: T | undefined;
    try {
      for (const row of rows) {
        if (
          foldEqual
          && this.mergeEqual
          && pending !== undefined
          && this.compare(pending, row) === 0
        ) {
          pending = this.mergeEqual(pending, row);
          continue;
        }
        if (pending !== undefined) await this.writeLine(output, this.encode(pending));
        pending = row;
      }
      if (pending !== undefined) await this.writeLine(output, this.encode(pending));
      const finished = once(output, 'finish');
      output.end();
      await finished;
    } catch (error) {
      output.destroy();
      throw error;
    }
  }

  private async writeLine(output: NodeJS.WritableStream, value: string): Promise<void> {
    if (!output.write(`${value}\n`, 'utf8')) await once(output, 'drain');
  }

  private async *readRun(path: string): AsyncGenerator<T> {
    const input = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line) yield this.decode(line);
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  private async nextRunPath(): Promise<string> {
    const directory = await this.ensureWorkDirectory();
    const path = join(directory, `run-${String(this.sequence).padStart(8, '0')}.jsonl`);
    this.sequence += 1;
    return path;
  }
}

/**
 * Keeps a small LRU in memory and spills the authoritative first value for a
 * key to sharded JSONL files. This preserves one label per export without an
 * export-sized Map of user contacts.
 */
export class FinanceExportDiskCache<T> {
  private readonly memory = new Map<string, T | null>();
  private directory: string | null = null;

  constructor(
    private readonly directoryPrefix: string,
    private readonly maxMemoryEntries = 10_000,
    private readonly bucketCount = 256,
  ) {}

  async getMany(keys: readonly string[]): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>();
    const missingByBucket = new Map<number, Set<string>>();
    for (const key of keys) {
      if (this.memory.has(key)) {
        const value = this.memory.get(key) ?? null;
        this.remember(key, value);
        result.set(key, value);
        continue;
      }
      const bucket = this.bucketFor(key);
      const keysInBucket = missingByBucket.get(bucket) ?? new Set<string>();
      keysInBucket.add(key);
      missingByBucket.set(bucket, keysInBucket);
    }
    if (missingByBucket.size === 0 || !this.directory) return result;

    await Promise.all(Array.from(missingByBucket.entries()).map(async ([bucket, wanted]) => {
      let content: string;
      try {
        content = await readFile(this.bucketPath(bucket), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      for (const line of content.split('\n')) {
        if (!line) continue;
        const [key, value] = JSON.parse(line) as [string, T | null];
        if (!wanted.has(key) || result.has(key)) continue;
        result.set(key, value);
        this.remember(key, value);
      }
    }));
    return result;
  }

  async setMany(entries: ReadonlyMap<string, T | null>): Promise<void> {
    if (entries.size === 0) return;
    const directory = await this.ensureDirectory();
    const linesByBucket = new Map<number, string[]>();
    for (const [key, value] of entries) {
      this.remember(key, value);
      const bucket = this.bucketFor(key);
      const lines = linesByBucket.get(bucket) ?? [];
      lines.push(JSON.stringify([key, value]));
      linesByBucket.set(bucket, lines);
    }
    await Promise.all(Array.from(linesByBucket.entries()).map(([bucket, lines]) => (
      appendFile(join(directory, `${bucket.toString(16).padStart(2, '0')}.jsonl`), `${lines.join('\n')}\n`, 'utf8')
    )));
  }

  async dispose(): Promise<void> {
    this.memory.clear();
    if (!this.directory) return;
    const directory = this.directory;
    this.directory = null;
    await rm(directory, { recursive: true, force: true });
  }

  private remember(key: string, value: T | null): void {
    if (this.memory.has(key)) this.memory.delete(key);
    this.memory.set(key, value);
    while (this.memory.size > Math.max(1, this.maxMemoryEntries)) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  private async ensureDirectory(): Promise<string> {
    if (!this.directory) this.directory = await mkdtemp(this.directoryPrefix);
    return this.directory;
  }

  private bucketPath(bucket: number): string {
    return join(this.directory!, `${bucket.toString(16).padStart(2, '0')}.jsonl`);
  }

  private bucketFor(key: string): number {
    let hash = 2166136261;
    for (let index = 0; index < key.length; index += 1) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % Math.max(1, this.bucketCount);
  }
}
