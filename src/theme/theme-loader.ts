import fs from 'fs';
import path from 'path';
import { ThemeConfig, TMConfig, EventIndexEntry, TMEvent } from '../types';

export interface Theme {
  name: string;
  config: ThemeConfig;
  templates: {
    home: string;
    event: string;
    archive: string;
  };
  assets: {
    css: string[];
    js: string[];
  };
}

export class ThemeLoader {
  private themesDir: string;

  constructor(projectRoot: string) {
    this.themesDir = path.join(projectRoot, 'themes');
  }

  async loadTheme(config: TMConfig): Promise<Theme> {
    const themeName = config.theme || 'default';
    const themeDir = path.join(this.themesDir, themeName);

    if (!fs.existsSync(themeDir)) {
      if (themeName === 'default') {
        return this.createFallbackTheme();
      }
      throw new Error(`Theme "${themeName}" not found in ${themeDir}`);
    }

    const themeConfig = await this.loadThemeConfig(themeDir);
    const templates = await this.loadTemplates(themeDir);
    const assets = await this.discoverAssets(themeDir);

    return {
      name: themeName,
      config: themeConfig,
      templates,
      assets,
    };
  }

  private async loadThemeConfig(themeDir: string): Promise<ThemeConfig> {
    const configPath = path.join(themeDir, 'theme.json');
    if (fs.existsSync(configPath)) {
      const content = await fs.promises.readFile(configPath, 'utf-8');
      return JSON.parse(content);
    }
    return { name: path.basename(themeDir) };
  }

  private async loadTemplates(themeDir: string): Promise<Theme['templates']> {
    const templatesDir = path.join(themeDir, 'templates');
    const result: Theme['templates'] = {
      home: '',
      event: '',
      archive: '',
    };

    const templateFiles = ['home.html', 'event.html', 'archive.html'];
    for (const file of templateFiles) {
      const filePath = path.join(templatesDir, file);
      if (fs.existsSync(filePath)) {
        result[file.replace('.html', '') as keyof Theme['templates']] =
          await fs.promises.readFile(filePath, 'utf-8');
      }
    }

    if (!result.home || !result.event || !result.archive) {
      const fallback = this.createFallbackTheme();
      if (!result.home) result.home = fallback.templates.home;
      if (!result.event) result.event = fallback.templates.event;
      if (!result.archive) result.archive = fallback.templates.archive;
    }

    return result;
  }

  private async discoverAssets(themeDir: string): Promise<Theme['assets']> {
    const cssDir = path.join(themeDir, 'css');
    const jsDir = path.join(themeDir, 'js');

    const css: string[] = [];
    const js: string[] = [];

    if (fs.existsSync(cssDir)) {
      const files = await fs.promises.readdir(cssDir);
      for (const file of files) {
        if (file.endsWith('.css')) {
          css.push(path.join(cssDir, file));
        }
      }
    }

    if (fs.existsSync(jsDir)) {
      const files = await fs.promises.readdir(jsDir);
      for (const file of files) {
        if (file.endsWith('.js')) {
          js.push(path.join(jsDir, file));
        }
      }
    }

    return { css, js };
  }

  private createFallbackTheme(): Theme {
    return {
      name: 'default',
      config: { name: 'default' },
      templates: {
        home: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ title }}</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .home { text-align: center; margin-top: 100px; }
    .launch-btn { padding: 12px 30px; font-size: 16px; cursor: pointer; }
  </style>
</head>
<body class="home">
  <h1>{{ title }}</h1>
  <p>{{ subtitle }}</p>
  <button class="launch-btn" id="launch-btn">开启探索</button>
  <div id="event-index" style="display:none">{{ indexJson }}</div>
</body>
</html>`,
        event: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ title }}</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
  </style>
</head>
<body>
  <a href="../index.html">← 返回</a>
  <h1>{{ title }}</h1>
  <div>{{ date }}</div>
  <article>{{ content }}</article>
  <div id="event-index" style="display:none">{{ indexJson }}</div>
</body>
</html>`,
        archive: `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{ title }}</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
  </style>
</head>
<body>
  <a href="index.html">← 返回</a>
  <h1>事件档案</h1>
  <div id="archive-grid"></div>
  <div id="event-index" style="display:none">{{ indexJson }}</div>
</body>
</html>`,
      },
      assets: { css: [], js: [] },
    };
  }

  async copyAssets(theme: Theme, outputPath: string): Promise<void> {
    const cssDest = path.join(outputPath, 'css');
    const jsDest = path.join(outputPath, 'js');

    await fs.promises.mkdir(cssDest, { recursive: true });
    await fs.promises.mkdir(jsDest, { recursive: true });

    for (const cssFile of theme.assets.css) {
      const dest = path.join(cssDest, path.basename(cssFile));
      await fs.promises.copyFile(cssFile, dest);
    }

    for (const jsFile of theme.assets.js) {
      const dest = path.join(jsDest, path.basename(jsFile));
      await fs.promises.copyFile(jsFile, dest);
    }
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  let result = template;

  result = result.replace(/{%\s*for\s+(\w+)\s+in\s+(\w+)\s*%}(.*?){%\s*endfor\s*%}/gs, (_, itemName, listName, content) => {
    const list = data[listName] as unknown[];
    if (!list || !Array.isArray(list)) return '';
    return list.map((item) => {
      return content.replace(new RegExp(`{{\\s*${itemName}\\s*}}`, 'g'), String(item));
    }).join('');
  });

  result = result.replace(/{%\s*if\s+(\w+)\s*%}(.*?){%\s*endif\s*%}/gs, (_, varName, content) => {
    return data[varName] ? content : '';
  });

  for (const [key, value] of Object.entries(data)) {
    const stringValue = typeof value === 'string' ? value : String(value);
    // Use a function replacer so "$", "$&", etc. in JSON/HTML are inserted literally.
    result = result.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), () => stringValue);
  }

  return result;
}