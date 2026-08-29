/**
 * Plugin Registry — maps plugin names to factory functions.
 * The Builder uses this to look up implementations by config.
 */

import type { PluginRegistry, IParser, IStorage, IRenderer, IImageProcessor } from './types';
import { LogseqParser } from './parsers/logseq/parser';
import { LocalStorage } from './storage/local';
import { R2Storage } from './storage/r2';
import { OSSStorage } from './storage/oss';
import { SharpImageProcessor } from './image/processor';
import { DefaultRenderer } from './renderers/default/renderer';

/** Create the default registry with built-in plugins. */
export function createDefaultRegistry(): PluginRegistry {
  return {
    parsers: new Map([['logseq', () => new LogseqParser()]]),
    storages: new Map([
      ['local', (basePath?: string) => new LocalStorage(basePath)] as any,
      ['r2', (basePath?: string) => new R2Storage(basePath)] as any,
      ['oss', (basePath?: string) => new OSSStorage(basePath)] as any,
    ]),
    renderers: new Map([['default', () => new DefaultRenderer()]]),
    imageProcessors: new Map([['sharp', () => new SharpImageProcessor()]]),
  };
}

// Re-export plugin classes for direct use
export { LogseqParser, LocalStorage, R2Storage, OSSStorage, SharpImageProcessor, DefaultRenderer };
