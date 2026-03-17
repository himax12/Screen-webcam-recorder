# Screen + Webcam Recorder

A cross-platform desktop application built with **Electron + React + TypeScript** that records your screen and webcam simultaneously and saves each session as separate files in a UUID-named folder.

## Demo

<video src="https://raw.githubusercontent.com/himax12/Screen-webcam-recorder/main/media/demo-preview.mp4" controls width="100%"></video>

[Open demo video directly](https://raw.githubusercontent.com/himax12/Screen-webcam-recorder/main/media/demo-preview.mp4)

---

## Setup

```bash
npm install
npm start
```

> **Note:** `npm start` launches the pre-built app (`dist/` + `dist-electron/`).  
> If those folders are missing (fresh clone), build first:
>
> ```bash
> npm install
> npm run build
> npm start
> ```
>
> For live development with hot-reload:
>
> ```bash
> npm run dev
> ```

---

## Features

### Core
- Lists all available **screens and windows** with live thumbnails — select any before recording
- **Screen and webcam recorded independently** — each has its own Start / Stop control
- Webcam capture is fully **optional** (toggle in Settings)
- Each session saved as `videos/<uuid>/screen.webm` and `videos/<uuid>/webcam.webm`

### Extra
- **"Recording Complete" screen** with an Open Folder button
- **Live timer** (HH:MM:SS) throughout recording
- **Rename session** — renames the folder on disk with the UUID preserved as a prefix
- **Export settings:**
  - Format: `webm` (no re-encode) or `mp4` (ffmpeg transcode)
  - Bitrate: `low` / `medium` / `high` / `custom` kbps
  - Custom save location via folder picker
- **Merged `final.mp4`** — when both streams exist, webcam is overlaid as a picture-in-picture in the bottom-right corner using ffmpeg

### Audio
- System audio capture (where supported by OS)
- Microphone mixing — mic audio is mixed into **both** `screen.webm` and `webcam.webm` via an `AudioContext` gain graph
- Microphone device selection with live refresh

---

## Session Layout

```
videos/
└── 4a12ffac-b243-4fa3-8c9f-1123dfeaa342/
    ├── screen.webm
    ├── webcam.webm        ← only if webcam was enabled
    ├── final.mp4          ← only after Export with format set to mp4
    └── session.json       ← metadata (name, duration, paths, export status)
```

Default save location:
- **Development:** `<project root>/videos/`
- **Packaged app:** `Documents/ScreenRecorder/videos/`

---

## Scripts

| Command | Description |
|---|---|
| `npm install` | Install dependencies |
| `npm start` | Launch packaged build |
| `npm run dev` | Dev mode with hot-reload |
| `npm run build` | Full production build |
| `npm run dist` | Build + package installer (`release/`) |
| `npm test` | Run unit tests |
| `npm run typecheck` | TypeScript type check |

---

## Tech Stack

- **Electron** — desktop runtime, IPC, `desktopCapturer`, `shell`
- **React 19 + TypeScript** — renderer UI
- **Vite** — renderer bundler
- **MediaRecorder API** — browser-native video capture, streamed in 1s chunks
- **Web Audio API** — `AudioContext` for mixing system audio + microphone
- **ffmpeg** — MP4 transcode and PiP merge (`ffmpeg-static` + optional bundled binary)
- **uuid + zod** — session IDs and input validation

---

## Known Limitations & Edge Cases

| Limitation | Detail |
|---|---|
| **System audio on Windows** | System audio capture requires the user to check "Share system audio" in the OS share picker. Not all window sources expose an audio track — only "Entire screen" reliably does. |
| **Camera/mic blocked by OS** | Even with Electron permission handlers set, macOS and Windows can block camera/microphone access at the OS privacy level. The app surfaces a clear error and continues recording what it can. |
| **ffmpeg availability** | MP4 export requires ffmpeg. The app bundles `ffmpeg-static` and checks `resources/ffmpeg/ffmpeg.exe` as a fallback. If neither is found, `.webm` files are still saved and the export error is shown in the UI. |
| **No session history on restart** | Sessions are written to disk (`session.json`) but the in-memory session list resets on app restart. Reloading past sessions from disk is not implemented. |
| **Mirror recursion** | Recording a source that includes the recorder window itself causes visual recursion in the preview. The app detects this (`captureRisk: 'warning'`), suppresses the live preview during recording ("clean mode"), and offers a one-click switch to a safe source. |
| **Browser-native `.webm` container** | `MediaRecorder` always writes WebM — re-encode via ffmpeg is required for `.mp4`. Seeking in very large `.webm` files may be imprecise without re-muxing. |

---

## Running Tests

```bash
npm test
```

Unit tests cover: session name sanitization · bitrate resolution · duration formatting · validation schemas · capture policy logic.
