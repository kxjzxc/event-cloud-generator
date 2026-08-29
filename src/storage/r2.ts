/**
 * Cloudflare R2 Storage Plugin (Placeholder)
 *
 * This is a stub implementation that delegates to LocalStorage.
 * Future implementation will use the S3-compatible API to upload
 * files directly to R2.
 *
 * Configuration (future):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY, R2_BUCKET
 */

import * as path from 'path';
import { LocalStorage } from './local';
import type { IStorage } from '../types';
import chalk from 'chalk';

export class R2Storage implements IStorage {
  readonly name = 'r2';
  private local: LocalStorage;

  constructor(basePath?: string) {
    console.log(chalk.yellow('⚠  R2 storage plugin is not yet implemented. Falling back to local storage.'));
    this.local = new LocalStorage(basePath || './dist');
  }

  async save(filePath: string, content: Buffer | string): Promise<void> {
    return this.local.save(filePath, content);
  }

  async read(filePath: string): Promise<Buffer> {
    return this.local.read(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    return this.local.exists(filePath);
  }
}
