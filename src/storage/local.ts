/**
 * Local Storage — writes files to the local filesystem.
 * The default IStorage implementation.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { IStorage } from '../types';

export class LocalStorage implements IStorage {
  readonly name = 'local';

  constructor(private basePath: string = '.') {}

  async save(filePath: string, content: Buffer | string): Promise<void> {
    const fullPath = path.resolve(this.basePath, filePath);
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, content);
  }

  async read(filePath: string): Promise<Buffer> {
    const fullPath = path.resolve(this.basePath, filePath);
    return fs.promises.readFile(fullPath);
  }

  async exists(filePath: string): Promise<boolean> {
    const fullPath = path.resolve(this.basePath, filePath);
    try {
      await fs.promises.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}
