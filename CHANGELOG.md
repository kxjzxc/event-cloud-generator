# Changelog

## Unreleased

### Added
- 全局音乐播放器：`music::` 声明曲目，卡片内播放按钮 + 页脚续播
- 构建时拉取网易云 / Spotify 元数据，缓存至 `.cache/music.json`（可离线复用）

### Changed
- **视频暂不支持**：`.mp4` / `.mov` / `.webm` 不再复制到 `dist/`，正文中的视频 Embed 会被忽略；构建日志会输出 `⚠ Video skipped`
- Journal 不再作为 Event 来源（仅通过 `[[页面]]` 推断日期）

### Migration
- 若笔记里依赖视频展示，需暂时改用图片或外链；恢复视频支持前不会出现在站点中
- CI / 本地重复构建建议缓存 `.cache/` 目录，减少对第三方音乐 API 的依赖
