/**
 * Event Cloud CLI — Hexo-style commands
 *
 * Commands (with aliases):
 *   evc generate | g     Build the static site           [-w] [-d] [-v] [-s] [-c]
 *   evc server   | s     Serve locally (auto-build)      [-p] [-w] [--no-build] [-o]
 *   evc deploy   | d     Deploy to remote host            [--platform] [-c]
 *   evc clean    | cl    Remove the output directory      [-c]
 *   evc new      | n     Create a new page in the graph   <title> [-c]
 *   evc init     [folder]  Scaffold a new project          [-g] [-o] [-f]
 *
 * Inspired by Hexo: `hexo g`, `hexo s`, `hexo clean`, `hexo new`
 */

import { Command } from 'commander';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, exec } from 'child_process';
import chalk from 'chalk';
import { Builder } from '../core/builder';
import { createDefaultRegistry } from '../registry';
import type { TMConfig } from '../types';

const program = new Command();

program
  .name('evc')
  .description('Event Cloud — Static Event Site Generator')
  .version('0.1.0');

// ── Shared: build runner ──────────────────────────────────────

async function runBuild(config: TMConfig, options: { dryRun?: boolean; verbose?: boolean }): Promise<void> {
  const registry = createDefaultRegistry();
  const builder = new Builder(registry, config);
  const stats = await builder.build({ dryRun: options.dryRun, verbose: options.verbose });

  if (!options.dryRun) {
    console.log(chalk.green('✓ Build complete.'));
    console.log();
    console.log(chalk.cyan('  Summary:'));
    console.log(chalk.gray(`    Events:     ${stats.events}`));
    console.log(chalk.gray(`    Images:     ${stats.images}`));
    if (stats.videos > 0) console.log(chalk.gray(`    Videos:     ${stats.videos}`));
    console.log(chalk.gray(`    Tags:       ${stats.tags}`));
    console.log(chalk.gray(`    Backlinks:  ${stats.backlinks}`));
    console.log(chalk.gray(`    Related:    ${stats.relatedPairs} pairs`));
    console.log(chalk.gray(`    Output:     ${stats.outputFiles} files`));
  }
}

// ── Shared: watch mode ────────────────────────────────────────

function startWatch(config: TMConfig, onRebuild: () => void): void {
  const watchPaths = [
    path.join(config.logseqPath, 'pages'),
    path.join(config.logseqPath, 'journals'),
    path.join(config.logseqPath, 'assets'),
  ].filter((p) => fs.existsSync(p));

  if (watchPaths.length === 0) {
    console.log(chalk.yellow('⚠  No directories to watch.'));
    return;
  }

  let debounceTimer: NodeJS.Timeout | null = null;

  const triggerRebuild = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log(chalk.cyan('\n⚙  Change detected — rebuilding...'));
      onRebuild();
    }, 300);
  };

  for (const watchPath of watchPaths) {
    try {
      fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Only care about .md files and media files
        const ext = path.extname(filename).toLowerCase();
        if (['.md', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.webm', '.svg'].includes(ext)) {
          triggerRebuild();
        }
      });
      console.log(chalk.gray(`   Watching: ${watchPath}`));
    } catch {
      // Fallback: poll the directory
      console.log(chalk.gray(`   Polling:  ${watchPath} (recursive watch unavailable)`));
    }
  }
}

// ── Shared: start server with port-conflict handling ──────────

function startServer(
  root: string,
  port: number,
  config: TMConfig,
  opts: { watch: boolean; open?: boolean; label: string; server?: http.Server },
): void {
  const server = opts.server || createStaticServer(root);
  const explicitPort = process.argv.includes('-p') || process.argv.includes('--port');

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      if (explicitPort) {
        // User explicitly asked for this port — show error
        console.error(chalk.red(`✗ Port ${port} is already in use.`));
        console.error(chalk.gray(`  Try a different port: evc s -p ${port + 1}`));
        console.error(chalk.gray(`  Or kill the process: npx kill-port ${port}`));
        process.exit(1);
      } else {
        // Auto-find next available port
        const nextPort = port + 1;
        console.log(chalk.yellow(`⚠  Port ${port} is in use, trying ${nextPort}...`));
        startServer(root, nextPort, config, { ...opts, server });
      }
    } else {
      console.error(chalk.red('✗ Server error:'), err.message);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log();
    console.log(chalk.cyan(`⚙  Event Cloud — ${opts.label}`));
    console.log(chalk.green(`✓ Serving at ${url}`));
    console.log(chalk.gray('  Press Ctrl+C to stop.'));

    if (opts.open) {
      openBrowser(url);
    }

    if (opts.watch) {
      console.log();
      console.log(chalk.cyan('👁  Watch mode — file changes will auto-rebuild.'));
      startWatch(config, async () => {
        try {
          await runBuild(config, {});
          console.log(chalk.green(`✓ Rebuilt. Refresh ${url} to see changes.`));
        } catch (err: any) {
          console.error(chalk.red('✗ Rebuild failed:'), err.message);
        }
      });
    }
  });
}

// ── Shared: open browser ──────────────────────────────────────

function openBrowser(url: string): void {
  const platform = os.platform();
  let cmd: string;
  if (platform === 'win32') cmd = `start "" "${url}"`;
  else if (platform === 'darwin') cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      console.log(chalk.gray(`   Open ${url} in your browser.`));
    }
  });
}

// ══════════════════════════════════════════════════════════════
// evc generate | g
// ══════════════════════════════════════════════════════════════

function makeGenerateCommand(name: string, alias: string) {
  return program
    .command(name)
    .alias(alias)
    .description('Build the static site from your Logseq graph')
    .option('-w, --watch', 'Watch for file changes and rebuild automatically')
    .option('-d, --dry-run', 'Parse only, do not generate output')
    .option('-v, --verbose', 'Verbose output')
    .option('-c, --config <path>', 'Config file path', 'config.json')
    .option('-s, --storage <name>', 'Storage plugin (local, r2, oss)', '')
    .action(async (opts: {
      watch?: boolean;
      dryRun?: boolean;
      verbose?: boolean;
      config: string;
      storage: string;
    }) => {
      try {
        const config = loadConfig(opts.config);
        if (opts.storage) config.storage = opts.storage;

        console.log(chalk.cyan('⚙  Event Cloud — Generate'));
        console.log(chalk.gray(`   Graph:  ${config.logseqPath}`));
        console.log(chalk.gray(`   Output: ${config.outputPath}`));
        console.log(chalk.gray(`   Storage: ${config.storage}`));
        console.log();

        await runBuild(config, { dryRun: opts.dryRun, verbose: opts.verbose });

        if (opts.watch && !opts.dryRun) {
          console.log();
          console.log(chalk.cyan('👁  Watch mode enabled. Press Ctrl+C to stop.'));
          startWatch(config, async () => {
            try {
              await runBuild(config, { verbose: opts.verbose });
            } catch (err: any) {
              console.error(chalk.red('✗ Rebuild failed:'), err.message);
            }
          });
        }
      } catch (err: any) {
        console.error(chalk.red('✗ Build failed:'), err.message);
        process.exit(1);
      }
    });
}

makeGenerateCommand('generate', 'g');
// Also keep 'build' as alias for backward compat
makeGenerateCommand('build', 'b');

// ══════════════════════════════════════════════════════════════
// evc server | s
// ══════════════════════════════════════════════════════════════

program
  .command('server')
  .alias('s')
  .description('Serve the site locally (auto-builds first, like `hexo s`)')
  .option('-p, --port <number>', 'Port number', '3000')
  .option('-c, --config <path>', 'Config file path', 'config.json')
  .option('--no-build', 'Skip the initial build (use existing dist/)')
  .option('-w, --watch', 'Watch for file changes and rebuild (enabled by default)', true)
  .option('-o, --open', 'Open browser automatically')
  .action(async (opts: {
    port: string;
    config: string;
    build: boolean;
    watch: boolean;
    open?: boolean;
  }) => {
    const config = loadConfig(opts.config);
    const port = parseInt(opts.port, 10);
    const root = path.resolve(config.outputPath);

    // Auto-build before serving (unless --no-build)
    if (opts.build) {
      console.log(chalk.cyan('⚙  Event Cloud — Auto-build before serving'));
      console.log();
      try {
        await runBuild(config, {});
        console.log();
      } catch (err: any) {
        console.error(chalk.red('✗ Build failed:'), err.message);
        // If dist/ already exists, serve it anyway
        if (!fs.existsSync(root)) {
          console.error(chalk.gray('  Fix the error above, or use --no-build to skip.'));
          process.exit(1);
        }
        console.log(chalk.yellow('⚠  Build failed, serving existing dist/ instead.'));
      }
    }

    if (!fs.existsSync(root)) {
      console.error(chalk.red(`✗ Output directory not found: ${root}`));
      console.error(chalk.gray('  Run `evc g` first, or remove --no-build flag.'));
      process.exit(1);
    }

    // Start static server
    startServer(root, port, config, { watch: opts.watch && opts.build, open: opts.open, label: 'Server' });
  });

// Also keep 'preview' as alias
program
  .command('preview')
  .alias('p')
  .description('Alias for `evc server`')
  .option('-p, --port <number>', 'Port number', '3000')
  .option('-c, --config <path>', 'Config file path', 'config.json')
  .option('--no-build', 'Skip the initial build')
  .option('-w, --watch', 'Watch for changes', true)
  .option('-o, --open', 'Open browser automatically')
  .action(async (opts: any) => {
    // Delegate to server logic by re-invoking
    const config = loadConfig(opts.config);
    const port = parseInt(opts.port, 10);
    const root = path.resolve(config.outputPath);

    if (opts.build) {
      console.log(chalk.cyan('⚙  Event Cloud — Auto-build before serving'));
      console.log();
      try {
        await runBuild(config, {});
        console.log();
      } catch (err: any) {
        console.error(chalk.red('✗ Build failed:'), err.message);
        if (!fs.existsSync(root)) process.exit(1);
        console.log(chalk.yellow('⚠  Serving existing dist/.'));
      }
    }

    if (!fs.existsSync(root)) {
      console.error(chalk.red(`✗ Output directory not found: ${root}`));
      process.exit(1);
    }

    const server = createStaticServer(root);
    startServer(root, port, config, { watch: opts.watch && opts.build, open: opts.open, label: 'Preview', server });
  });

// ══════════════════════════════════════════════════════════════
// evc clean | cl
// ══════════════════════════════════════════════════════════════

program
  .command('clean')
  .alias('cl')
  .description('Remove the output directory entirely (including cached images)')
  .option('-c, --config <path>', 'Config file path', 'config.json')
  .action((opts: { config: string }) => {
    const config = loadConfig(opts.config);
    const outputDir = path.resolve(config.outputPath);

    if (!fs.existsSync(outputDir)) {
      console.log(chalk.gray('✓ Output directory does not exist. Nothing to clean.'));
      return;
    }

    console.log(chalk.cyan('⚙  Event Cloud — Clean'));
    console.log(chalk.gray(`   Removing: ${outputDir}`));

    fs.rmSync(outputDir, { recursive: true, force: true });

    console.log(chalk.green('✓ Cleaned.'));
    console.log(chalk.gray('  Run `evc g` to rebuild.'));
  });

// ══════════════════════════════════════════════════════════════
// evc new | n
// ══════════════════════════════════════════════════════════════

program
  .command('new <title>')
  .alias('n')
  .description('Create a new page in your Logseq graph')
  .option('-c, --config <path>', 'Config file path', 'config.json')
  .option('-d, --date <date>', 'Override the date (YYYY-MM-DD)', '')
  .action((title: string, opts: { config: string; date: string }) => {
    const config = loadConfig(opts.config);
    const pagesDir = path.join(config.logseqPath, 'pages');

    if (!fs.existsSync(pagesDir)) {
      fs.mkdirSync(pagesDir, { recursive: true });
    }

    const fileName = `${title}.md`;
    const filePath = path.join(pagesDir, fileName);

    if (fs.existsSync(filePath)) {
      console.error(chalk.red(`✗ Page already exists: ${filePath}`));
      process.exit(1);
    }

    const today = opts.date || new Date().toISOString().slice(0, 10);

    const template = `# ${title}

date:: ${today}
tags:: 

Write your content here.

- Use [[double-bracket]] to link other pages
- Use #tags to add tags inline
- Use ![](../assets/photo.jpg) to embed images
`;

    fs.writeFileSync(filePath, template, 'utf-8');

    console.log(chalk.green('✓ Created new page.'));
    console.log(chalk.gray(`   ${filePath}`));
    console.log();
    console.log(chalk.gray('  Run `evc g` to rebuild, or `evc s` to preview.'));
  });

// ══════════════════════════════════════════════════════════════
async function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Git command failed: git ${args.join(' ')}\n${stderr}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * Trigger a GitHub Actions `repository_dispatch` event to kick off the
 * CI deploy pipeline. This keeps local and CI builds consistent —
 * the actual build + gh-pages push is always handled by the same workflow.
 *
 * Required env var: GITHUB_TOKEN (a PAT with `repo` scope)
 * Required config:  deploy.repo or deploy.githubRepo
 */
async function deployToGithubPages(config: TMConfig): Promise<void> {
  const deployConfig = config.deploy;
  if (!deployConfig || deployConfig.type !== 'github-pages') {
    console.error(chalk.red('✗ Deploy config not found or invalid.'));
    console.error(chalk.gray('  Ensure config.json has "deploy": { "type": "github-pages", "repo": "..." }'));
    process.exit(1);
  }

  // Resolve owner/repo slug from deploy.githubRepo or parse deploy.repo URL
  let slug = process.env.EVC_GITHUB_REPO || deployConfig.githubRepo;
  if (!slug) {
    const repoUrl = process.env.EVC_DEPLOY_REPO || deployConfig.repo;
    if (!repoUrl) {
      console.error(chalk.red('✗ Cannot determine GitHub repository.'));
      console.error(chalk.gray('  Set "deploy.githubRepo" (e.g. "owner/repo") in config.json'));
      console.error(chalk.gray('  or export EVC_GITHUB_REPO=owner/repo'));
      process.exit(1);
    }
    const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (!match) {
      console.error(chalk.red(`✗ Cannot parse GitHub repo from URL: ${repoUrl}`));
      process.exit(1);
    }
    slug = match[1].replace(/\.git$/, '');
  }

  const token = process.env.GITHUB_TOKEN || process.env.EVC_GITHUB_TOKEN;
  if (!token) {
    console.error(chalk.red('✗ GitHub token not found.'));
    console.error(chalk.gray('  Export GITHUB_TOKEN=<PAT with repo scope>'));
    console.error(chalk.gray('  The PAT must have "repo" (or "public_repo") permission.'));
    process.exit(1);
  }

  const apiUrl = `https://api.github.com/repos/${slug}/dispatches`;
  const payload = JSON.stringify({
    event_type: 'deploy',
    client_payload: { triggered_by: 'evc-deploy', timestamp: new Date().toISOString() },
  });

  console.log(chalk.cyan(`   Triggering CI deploy for ${slug}...`));

  await new Promise<void>((resolve, reject) => {
    const url = new URL(apiUrl);
    const reqOpts = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'event-cloud-cli',
      },
    };

    const https = require('https') as typeof import('https');
    const req = https.request(reqOpts, (res) => {
      if (res.statusCode === 204) {
        resolve();
      } else {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          reject(new Error(`GitHub API responded with ${res.statusCode}: ${body}`));
        });
      }
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  }).catch((err: Error) => {
    console.error(chalk.red('✗ Deploy failed — could not trigger CI workflow:'));
    console.error(chalk.gray(`  ${err.message}`));
    process.exit(1);
  });

  console.log(chalk.green('✓ CI deploy triggered!'));
  console.log(chalk.gray(`   GitHub Actions will build and publish the site.`));
  console.log(chalk.gray(`   Track progress: https://github.com/${slug}/actions`));
  const [owner, repo] = slug.split('/');
  console.log(chalk.gray(`   Live site (once deployed): https://${owner}.github.io/${repo}/`));
}

// evc deploy | d
// ══════════════════════════════════════════════════════════════

program
  .command('deploy')
  .alias('d')
  .description('Deploy the site to a remote host')
  .option('-p, --platform <name>', 'Deployment platform (github-pages, r2, oss)', '')
  .option('-c, --config <path>', 'Config file path', 'config.json')
  .option('--no-build', 'Skip build before deploy')
  .action(async (opts: { platform: string; config: string; build: boolean }) => {
    const config = loadConfig(opts.config);

    const platform = opts.platform || (config.deploy?.type || 'github-pages');
    const supported = ['github-pages', 'r2', 'oss'];

    console.log(chalk.cyan('⚙  Event Cloud — Deploy'));
    console.log(chalk.gray(`   Platform: ${platform}${opts.platform ? ' (from CLI)' : config.deploy?.type ? ' (from config)' : ' (default)'}`));
    console.log();

    if (!supported.includes(platform)) {
      console.error(chalk.red(`✗ Unknown platform: ${platform}`));
      console.error(chalk.gray(`  Supported: ${supported.join(', ')}`));
      process.exit(1);
    }

    if (opts.build) {
      console.log(chalk.gray('   Building before deploy...'));
      try {
        await runBuild(config, {});
        console.log();
      } catch (err: any) {
        console.error(chalk.red('✗ Build failed:'), err.message);
        process.exit(1);
      }
    }

    if (platform === 'github-pages') {
      await deployToGithubPages(config);
    } else if (platform === 'r2') {
      console.log(chalk.yellow(`⚠  Deploy to ${platform} is not yet implemented.`));
      console.log(chalk.gray('  This will be available in a future release.'));
      console.log();
      console.log(chalk.gray('  Manual deployment guide:'));
      console.log(chalk.white('  Cloudflare R2:'));
      console.log(chalk.gray('    wrangler r2 object put <bucket>/index.html --file dist/index.html'));
    } else if (platform === 'oss') {
      console.log(chalk.yellow(`⚠  Deploy to ${platform} is not yet implemented.`));
      console.log(chalk.gray('  This will be available in a future release.'));
      console.log();
      console.log(chalk.gray('  Manual deployment guide:'));
      console.log(chalk.white('  Aliyun OSS:'));
      console.log(chalk.gray('    ossutil sync dist/ oss://<bucket>/'));
    }
  });

// ══════════════════════════════════════════════════════════════
// evc init [folder]
// ══════════════════════════════════════════════════════════════

program
  .command('init [folder]')
  .description('Scaffold a new Event Cloud project (like `hexo init`)')
  .option('-g, --graph <path>', 'Graph directory path', './graph')
  .option('-o, --output <path>', 'Output directory path', './dist')
  .option('-f, --force', 'Overwrite existing files')
  .action((folder: string | null, opts: { graph: string; output: string; force?: boolean }) => {
    const targetDir = folder ? path.resolve(folder) : process.cwd();

    // Create target directory if specified and doesn't exist
    if (folder && !fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    if (folder) {
      console.log(chalk.cyan('⚙  Event Cloud — Init'));
      console.log(chalk.gray(`   Target: ${targetDir}`));
      console.log();
    } else {
      console.log(chalk.cyan('⚙  Event Cloud — Init'));
      console.log(chalk.gray(`   Target: ${targetDir} (current directory)`));
      console.log();
    }

    const force = opts.force || false;

    // ── 1. Directory structure ──────────────────────────────
    const graphDir = path.resolve(targetDir, opts.graph);
    const outputDir = path.resolve(targetDir, opts.output);
    const dirsToCreate = [
      graphDir,
      path.join(graphDir, 'pages'),
      path.join(graphDir, 'journals'),
      path.join(graphDir, 'assets'),
    ];

    for (const dir of dirsToCreate) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(chalk.gray(`   ${path.relative(targetDir, dir) || dir}/`));
      } else {
        console.log(chalk.gray(`   ${path.relative(targetDir, dir) || dir}/ (exists)`));
      }
    }

    // ── 2. config.json ──────────────────────────────────────
    const configPath = path.join(targetDir, 'config.json');
    if (fs.existsSync(configPath) && !force) {
      console.log(chalk.yellow('   config.json (exists, skipped)'));
    } else {
      const config = {
        logseqPath: opts.graph,
        outputPath: opts.output,
        storage: 'local',
        media: {
          thumbnailSize: 200,
          previewSize: 800,
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
      console.log(chalk.green('   config.json ✓'));
    }

    // ── 3. .gitignore ───────────────────────────────────────
    const gitignorePath = path.join(targetDir, '.gitignore');
    if (fs.existsSync(gitignorePath) && !force) {
      console.log(chalk.yellow('   .gitignore (exists, skipped)'));
    } else {
      const gitignore = [
        '# Event Cloud',
        'node_modules/',
        'lib/',
        'dist/',
        '',
        '# Logseq data (uncomment if you don\'t want to track it)',
        '# graph/',
        '',
        '# OS files',
        '.DS_Store',
        'Thumbs.db',
        '',
      ].join('\n');
      fs.writeFileSync(gitignorePath, gitignore, 'utf-8');
      console.log(chalk.green('   .gitignore ✓'));
    }

    // ── 4. Sample page ──────────────────────────────────────
    const samplePagePath = path.join(graphDir, 'pages', 'Welcome.md');
    if (fs.existsSync(samplePagePath) && !force) {
      console.log(chalk.yellow('   graph/pages/Welcome.md (exists, skipped)'));
    } else {
      const today = new Date().toISOString().slice(0, 10);
      const samplePage = `# Welcome to Event Cloud

date:: ${today}
tags:: #guide

This is your first page. Each \`pages/*.md\` file becomes an **Event** — an event card in the Event Cloud.

## What you can do

- Write in standard **Markdown**
- Link to other pages with [[double brackets]] — like [[Tokyo Trip]]
- Add tags with \`#\` prefix: #travel #food
- Embed images with \`![[photo.jpg]]\` (put files in \`assets/\`)
- Embed videos with \`![[video.mp4]]\`

## Example

Here's a photo placeholder:

![[welcome.svg]]

## Next steps

1. Delete this file and create your own pages in \`pages/\`
2. Put images in \`assets/\`
3. Run \`ec g\` to build, \`ec s\` to preview

> Remember: Logseq is the source of truth. Event Cloud only reads, never modifies.
`;
      fs.writeFileSync(samplePagePath, samplePage, 'utf-8');
      console.log(chalk.green('   graph/pages/Welcome.md ✓'));
    }

    // ── 5. Sample asset (SVG placeholder) ───────────────────
    const sampleAssetPath = path.join(graphDir, 'assets', 'welcome.svg');
    if (fs.existsSync(sampleAssetPath) && !force) {
      console.log(chalk.yellow('   graph/assets/welcome.svg (exists, skipped)'));
    } else {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400">
  <rect width="800" height="400" fill="#1a1a2e"/>
  <text x="400" y="180" font-family="sans-serif" font-size="36" fill="#e0e0e0" text-anchor="middle">Event Cloud</text>
  <text x="400" y="230" font-family="sans-serif" font-size="18" fill="#888" text-anchor="middle">Replace this with your own image</text>
</svg>
`;
      fs.writeFileSync(sampleAssetPath, svg, 'utf-8');
      console.log(chalk.green('   graph/assets/welcome.svg ✓'));
    }

    // ── 6. Done ─────────────────────────────────────────────
    console.log();
    console.log(chalk.green('✓ Project scaffolded.'));
    console.log();
    console.log(chalk.white('  Project structure:'));
    console.log(chalk.gray('  ├── config.json'));
    console.log(chalk.gray('  ├── .gitignore'));
    console.log(chalk.gray('  └── graph/'));
    console.log(chalk.gray('      ├── pages/       ← your content (.md files)'));
    console.log(chalk.gray('      │   └── Welcome.md'));
    console.log(chalk.gray('      ├── journals/    ← Logseq journals (optional)'));
    console.log(chalk.gray('      └── assets/      ← images & videos'));
    console.log(chalk.gray('          └── welcome.svg'));
    console.log();
    console.log(chalk.white('  Next steps:'));
    if (folder) {
      console.log(chalk.cyan(`    cd ${folder}`));
    }
    console.log(chalk.gray('    1. Edit pages in graph/pages/'));
    console.log(chalk.gray('    2. Run ') + chalk.cyan('evc g') + chalk.gray(' to build'));
    console.log(chalk.gray('    3. Run ') + chalk.cyan('evc s') + chalk.gray(' to preview at http://localhost:3000'));
    console.log();
    console.log(chalk.gray('    Or run ') + chalk.cyan('evc s -o') + chalk.gray(' to build + serve + open browser'));
  });

// ══════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════

function createStaticServer(root: string): http.Server {
  return http.createServer((req, res) => {
    let urlPath = req.url || '/';

    // Strip query string
    const qIdx = urlPath.indexOf('?');
    if (qIdx >= 0) urlPath = urlPath.slice(0, qIdx);

    // Decode URL-encoded characters (e.g., %E6%97%B6 → 时)
    try {
      urlPath = decodeURIComponent(urlPath);
    } catch {
      // Invalid encoding, keep as-is
    }

    // Default to index.html
    if (urlPath === '/') urlPath = '/index.html';

    // Handle directory: serve index.html inside it
    let filePath = path.join(root, urlPath);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    // Security: prevent path traversal
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath)) {
      // Try with .html extension
      const htmlPath = filePath + '.html';
      if (fs.existsSync(htmlPath)) {
        filePath = htmlPath;
      } else {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.webp': 'image/webp',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.ico': 'image/x-icon',
    };

    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function loadConfig(configPath: string): TMConfig {
  const fullPath = path.resolve(configPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Config file not found: ${fullPath}`);
  }
  const raw = fs.readFileSync(fullPath, 'utf-8');
  const config = JSON.parse(raw) as TMConfig;

  // Resolve relative paths
  config.logseqPath = path.resolve(path.dirname(fullPath), config.logseqPath);
  config.outputPath = path.resolve(path.dirname(fullPath), config.outputPath);

  return config;
}

// ══════════════════════════════════════════════════════════════
// Run
// ══════════════════════════════════════════════════════════════

program.parse(process.argv);
