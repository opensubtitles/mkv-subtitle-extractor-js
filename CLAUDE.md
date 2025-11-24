# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based MKV/MP4 subtitle extractor using React 19, TypeScript, and WebAssembly-compiled FFmpeg. All processing happens client-side with no server uploads.

## Development Commands

```bash
npm run dev      # Start dev server (http://localhost:5174)
npm run build    # TypeScript check + Vite build
npm run lint     # ESLint
npm run preview  # Preview production build
npm run deploy   # Build and deploy to GitHub Pages
```

## Architecture

**Single-page app** with one main component (`src/App.tsx`) that handles:
- File drag-and-drop/selection
- Web Worker communication with FFmpeg/FFprobe
- Progress tracking
- ZIP generation and download

**Web Workers** (in `public/`):
- `ffprobe-worker-mkve.js` + `.wasm` - Analyzes video files, returns JSON with stream info
- `ffmpeg-worker-mkve.js` + `.wasm` - Extracts subtitle streams

**Worker communication pattern**:
1. Worker posts `ready` when loaded
2. App sends `run` with arguments and WORKERFS mount
3. Worker posts `stdout`/`stderr` during execution
4. Worker posts `done` with MEMFS result (extracted files)

**Build configuration** (`vite.config.ts`):
- Uses conditional base path: `/mkv-subtitle-extractor-js/` for production, `/` for dev
- Worker paths use `import.meta.env.BASE_URL` for correct resolution

## Important Constraints

**NEVER use ffmpeg.asm or any asm.js-based FFmpeg builds. Only FFmpeg.js (WebAssembly) is allowed. No exceptions.**

## Key Implementation Details

- FFprobe output parsed as JSON to detect subtitle tracks
- MP4 subtitles (mov_text codec) converted to SRT; MKV subtitles copied directly
- All subtitles extracted in single FFmpeg call for performance
- Results packaged into ZIP using JSZip
