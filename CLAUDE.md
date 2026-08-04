# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**easydu** (简读/静读) is a browser-based Chinese ebook reader. It supports `.txt`, `.md`, and `.epub` formats with features including bookshelf management, reading progress tracking, bookmarks, full-text search, and reading statistics.

## Tech Stack

- **Zero-tooling vanilla JS/HTML/CSS** — no build system, no bundler, no package.json, no tests, no linter
- Single-page application: [index.html](index.html), [script.js](script.js), [style.css](style.css)
- CDN dependencies: **JSZip** (EPUB parsing), **marked** (Markdown rendering)
- Google Fonts: LXGW WenKai TC (Chinese calligraphic font)
- **IndexedDB** stores book content; **localStorage** stores library metadata, progress, bookmarks, settings, statistics

## Development

To run locally, open `index.html` in a browser or serve with any static file server:

```bash
npx serve .
# or
python3 -m http.server
```

There are no build, test, or lint commands — the project runs directly from source.

## Architecture

All application logic lives in a single IIFE in [script.js](script.js). The code is organized by functional sections (referenced by comment headers):

| Section | Purpose |
|---|---|
| IndexedDB | `openDB`, `dbSave`, `dbLoad`, `dbDelete` — persistent book content storage |
| Library | `getLib`, `saveLib`, `addToLib`, `removeFromLib` — bookshelf metadata in localStorage |
| Cover Generation | `generateCoverDataUrl` — Canvas-based procedural cover art with gradient colors |
| EPUB Parser | `parseEPUB`, `resolvePath` — full EPUB extraction with cover/inline image resolution |
| Settings | `loadSettings`, `saveSettings`, `applySettings` — theme, font, layout preferences |
| Bookshelf UI | `renderBookshelf`, `showBookshelf`, `hideBookshelf` — card grid with progress bars |
| File Handling | `handleFile`, `handleEPUB`, `loadBookFromShelf`, `deleteBook` — import/open/delete |
| Content Splitting | `splitTxt`, `splitByPara`, `splitMD` — chapter detection (Chinese chapter patterns for TXT) |
| Seamless Rendering | `initSeamless`, `appendChapter`, `prependChapter`, `checkInfinite`, `trimChapters` — virtual scroll / infinite loading |
| Progress | `getAccurateProgress`, `updateProgress`, `jumpToPercent`, `setupProgressDrag` — scroll-position-granular progress |
| Bookmarks | `toggleBookmark`, `getBookmarks`, `renderBookmarks` — bookmarks with text snippets |
| Search | `doSearch`, `applyHighlights`, `navigateToResult` — full-text search with highlighting |
| TOC | `buildTOC`, `highlightToc` — sidebar table of contents with current-chapter tracking |
| Reading Timer | `startReadingTimer`, `stopReadingTimer`, `tickReading` — reading time statistics |
| Events | `setupEvents`, `setupSettingsEvents` — DOM events including mobile touch gestures |

## Two Screens

The app has two main views, toggled via CSS class `.active`:

1. **Bookshelf** (`#bookshelf`) — default view, card grid of imported books
2. **Reader** (`#reader`) — reading view with overlay panels:
   - Sidebar (`#sidebar`) — TOC and bookmarks (slides from left)
   - Settings (`#settings`) — reading preferences (slides from right)
   - Search bar (`#search-bar`) — drops down below toolbar
   - Toolbar (`#toolbar`) — top nav, appears on tap/click in top half

## Key Constants

Defined at the top of `script.js` (line 17):

- `CH_HEADING_GAP`, `BM_OFFSET_TOL` — chapter/bookmark tolerances
- `SCROLL_BOUND`, `PARA_MAX` — scroll and paragraph thresholds
- `SAVE_DELAY`, `PROC_DELAY` — debounce timings (ms)
- `SWIPE_MIN` — minimum swipe distance for mobile page turning

## Chinese-Aware Features

- Chapter splitting uses regex for Chinese patterns: `第X章`, `第X节`, `第X回`, `卷X`, `序章`, `楔子`, etc.
- Character encoding auto-detection: UTF-8 vs GBK for text files
- Cover generation uses LXGW WenKai TC font for title rendering

## Data Flow

1. User imports file → `handleFile` → parsed/split into chapters → saved to IndexedDB + library metadata to localStorage
2. Opening from bookshelf → `loadBookFromShelf` → loads from IndexedDB → renders with seamless scrolling
3. Progress/bookmarks/settings → persisted to localStorage with debounced saves

## Git Publishing

- When the user explicitly requests a commit and push, commit directly on the current `main` branch and push `main`.
- Do not create a temporary release branch unless the user explicitly requests one.
- After merging any temporary branch, delete both its local and remote copies.
