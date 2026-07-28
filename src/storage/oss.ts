/**
 * Aliyun OSS Storage Plugin (Placeholder)
 *
 * This is a stub implementation that delegates to LocalStorage.
 * Future implementation will use the OSS SDK to upload files
 * directly to Aliyun Object Storage Service.
 *
 * Configuration (future):
 *   OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_BUCKET, OSS_REGION
 */

import { LocalStorage } from './local';
import type { IStorage } from '../types';
import chalk from 'chalk';

export class OSSStorage implements IStorage {
  readonly name = 'oss';
  private local: LocalStorage;

  constructor(basePath?: string) {
    console.log(chalk.yellow('⚠  OSS storage plugin is not yet implemented. Falling back to local storage.'));
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
