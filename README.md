# MKV Subtitle Extractor

Modern React-based web application for extracting all subtitle tracks from MKV files directly in your browser.

## Features

- **Browser-based** - No server upload required, everything runs locally
- **Fast extraction** - Extracts all subtitles in a single FFmpeg operation
- **Modern UI** - Beautiful gradient design with drag-and-drop support
- **Progress tracking** - Real-time feedback during extraction
- **Automatic ZIP** - All subtitles packaged and downloaded automatically

## Tech Stack

- **React 19** - Latest React with modern hooks
- **TypeScript** - Full type safety
- **Vite** - Lightning-fast build tool
- **FFmpeg.js** - WebAssembly-compiled FFmpeg for browser
- **JSZip** - ZIP file generation

## Quick Start

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

The app will be available at http://localhost:5174/

## Usage

1. Open the application in your browser
2. Drag and drop an MKV file (or click to browse)
3. Wait for extraction to complete
4. ZIP file with all subtitles downloads automatically

## Performance

This implementation uses an optimized approach that extracts all subtitle tracks in a **single FFmpeg call**, making it significantly faster than sequential extraction methods.

## Supported Subtitle Formats

- SRT (SubRip)
- ASS (Advanced SubStation Alpha)
- SSA (SubStation Alpha)
- And all other formats supported by FFmpeg

## Browser Compatibility

Works in all modern browsers that support:
- WebAssembly
- Web Workers
- File API
- Drag and Drop API

## License

MIT
