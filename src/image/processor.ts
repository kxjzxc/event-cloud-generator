/**
 * Image Processor — generates thumbnail.webp and preview.webp derivatives.
 * Uses sharp for high-performance image processing.
 *
 * Incremental: skips files that already exist in the output directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import sharp from 'sharp';
import type { IImageProcessor, ImageProcessConfig, ProcessedImage } from '../types';

export class SharpImageProcessor implements IImageProcessor {
  readonly name = 'sharp';

  async process(
    inputPath: string,
    outputDir: string,
    config: ImageProcessConfig,
  ): Promise<ProcessedImage> {
    const ext = path.extname(inputPath).toLowerCase();
    const basename = path.basename(inputPath, ext);
    const thumbnailPath = path.join(outputDir, 'thumbnails', `${basename}.webp`);
    const previewPath = path.join(outputDir, 'previews', `${basename}.webp`);

    // Ensure output directories exist
    await fs.promises.mkdir(path.dirname(thumbnailPath), { recursive: true });
    await fs.promises.mkdir(path.dirname(previewPath), { recursive: true });

    // Incremental: skip if both files exist
    const thumbExists = fs.existsSync(thumbnailPath);
    const previewExists = fs.existsSync(previewPath);

    if (!thumbExists) {
      await sharp(inputPath)
        .resize(config.thumbnailSize, config.thumbnailSize, {
          fit: 'cover',
          position: 'centre',
        })
        .webp({ quality: 80 })
        .toFile(thumbnailPath);
    }

    if (!previewExists) {
      await sharp(inputPath)
        .resize(config.previewSize, config.previewSize, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 85 })
        .toFile(previewPath);
    }

    return {
      thumbnailPath,
      previewPath,
      originalFilename: path.basename(inputPath),
    };
  }
}
