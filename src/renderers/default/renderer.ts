import type { IRenderer, TMEvent, EventIndexEntry, RenderContext } from '../../types';
import { ThemeLoader, renderTemplate } from '../../theme/theme-loader';

export class DefaultRenderer implements IRenderer {
  readonly name = 'default';

  async render(
    events: TMEvent[],
    index: EventIndexEntry[],
    ctx: RenderContext,
    aboutHtml: string = '',
  ): Promise<void> {
    const { storage, config } = ctx;
    const indexJson = JSON.stringify(index);

    const themeLoader = new ThemeLoader(process.cwd());
    const theme = await themeLoader.loadTheme(config);
    await themeLoader.copyAssets(theme, ctx.outputPath);

    const titleMap = new Map(events.map((e) => [e.id, e.title]));

    // Escape </script> so JSON can safely sit inside <script type="application/json">
    // without prematurely closing the tag when contentHtml contains iframes/scripts.
    const eventsJson = JSON.stringify(events).replace(/<\/script/gi, '<\\/script');

    await storage.save('index.html', this.renderHome(indexJson, eventsJson, theme, aboutHtml));
    await storage.save('archive.html', this.renderArchive(indexJson, eventsJson, theme, aboutHtml));

    for (const event of events) {
      const html = this.renderEvent(event, titleMap, indexJson, theme);
      await storage.save(`events/${event.id}.html`, html);
    }
  }

  private renderHome(
    indexJson: string,
    eventsJson: string,
    theme: { templates: { home: string } },
    aboutHtml: string = '',
  ): string {
    return renderTemplate(theme.templates.home, {
      title: 'Event Cloud',
      subtitle: '随机探索，遇见过去的自己',
      indexJson,
      eventsJson,
      aboutHtml,
      hasAbout: aboutHtml.trim().length > 0,
    });
  }

  private renderArchive(
    indexJson: string,
    eventsJson: string,
    theme: { templates: { archive: string } },
    aboutHtml: string = '',
  ): string {
    return renderTemplate(theme.templates.archive, {
      title: '事件馆 — Event Cloud',
      indexJson,
      eventsJson,
      aboutHtml,
      hasAbout: aboutHtml.trim().length > 0,
    });
  }

  private renderEvent(
    event: TMEvent,
    titleMap: Map<string, string>,
    indexJson: string,
    theme: { templates: { event: string } },
  ): string {
    const titleToId = new Map<string, string>();
    for (const [id, title] of titleMap) {
      titleToId.set(title.toLowerCase(), id);
    }

    let resolvedContent = event.contentHtml.replace(
      /<a href="#([^"]+)" class="tm-link">/g,
      (match, encodedName: string) => {
        const linkName = decodeURIComponent(encodedName);
        const targetId = titleToId.get(linkName.toLowerCase());
        if (targetId) {
          return `<a href="${targetId}.html" class="tm-link">`;
        }
        return `<span class="tm-link-dead">`;
      },
    );
    resolvedContent = resolvedContent.replace(
      /<span class="tm-link-dead">([^<]+)<\/a>/g,
      '<span class="tm-link-dead">$1</span>',
    );

    const tagsHtml = event.tags.map((t) => `<span class="tag">#${t}</span>`).join('');

    const linksHtml =
      event.links.length > 0
        ? `<div class="event-links">链接: ${event.links
            .map((l) => {
              const targetId = titleToId.get(l.toLowerCase());
              if (targetId) return `<a href="${targetId}.html">${l}</a>`;
              return `<span class="tm-link-dead">${l}</span>`;
            })
            .join('')}</div>`
        : '';

    const siblingsHtml =
      event.siblingIds.length > 0
        ? `<div class="siblings">
            <h4>同一天</h4>
            <div class="sibling-list">
              ${event.siblingIds
                .map((id) => {
                  const title = titleMap.get(id) || id;
                  return `<a class="sibling-item" href="${id}.html">${title}</a>`;
                })
                .join('')}
            </div>
          </div>`
        : '';

    const backlinksHtml =
      event.backlinkIds.length > 0
        ? `<div class="siblings">
            <h4>被引用</h4>
            <div class="sibling-list">
              ${event.backlinkIds
                .map((id) => {
                  const title = titleMap.get(id) || id;
                  return `<a class="sibling-item backlink" href="${id}.html">${title}</a>`;
                })
                .join('')}
            </div>
          </div>`
        : '';

    const relatedHtml =
      event.relatedIds.length > 0
        ? `<div class="siblings">
            <h4>相关记忆</h4>
            <div class="sibling-list">
              ${event.relatedIds
                .map((id) => {
                  const title = titleMap.get(id) || id;
                  return `<a class="sibling-item related" href="${id}.html">${title}</a>`;
                })
                .join('')}
            </div>
          </div>`
        : '';

    // Images are rendered inline in contentHtml (preserving original order).
    // Video embeds are not supported yet and are stripped at parse time.

    const siblings = siblingsHtml + backlinksHtml + relatedHtml;

    return renderTemplate(theme.templates.event, {
      title: `${event.title} — Event Cloud`,
      date: event.date,
      eventId: event.id,
      content: resolvedContent,
      media: '',
      tags: event.tags,
      tagsHtml,
      links: linksHtml,
      siblings,
      indexJson,
    });
  }
}