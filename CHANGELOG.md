# Changelog

The changes a user can see, newest release first.

## 1.0.2 — 2026-11-27
- The plugin now also declares `rest.fal.ai`, where fal's client starts a picture upload, and the README says exactly which fal.ai hosts live mode reaches and what the hooks run. Nothing changes in how studio works.

## 1.0.1 — 2026-11-27
- The README and the plugin listing now say first what studio is (AI image and video generation), what it costs, what it needs, what it runs and what it sends, and the plugin carries search keywords.

## 1.0.0 — 2026-11-25
- studio is stable at 1.0.0. Nothing changes in how it works since 0.3.0, and an installed 0.x updates as usual. This repository now holds released versions only, one commit per release.
- Make images and videos by asking Claude in plain words, in any language. Claude settles a brief by asking questions, shows a free drawn preview, prices the work, and generates only after you approve the estimate in the conversation.
- Fake mode by default: the whole flow runs on your machine with no key, no network and no money spent. Live mode uses image and video models on fal.ai, billed to your own fal.ai account; every generation call has a time limit and a cost cap, and is written to the work's `spend.jsonl`.
- A video starts from keyframes you confirm on a contact sheet. studio then adds drawn text and captions, assembles the work with ffmpeg and reviews its frames with you.
- Your works, assets, price records and prompt lessons stay in a studio folder you choose, never in the plugin folder, which every update replaces.
- The fal key goes only into the install's masked field. It is kept in the macOS Keychain, or in an owner-only file on Windows and Linux, and a hook refuses the common ways of reading it into the conversation.
- Runs on macOS, Windows and Linux (including WSL2), with Claude Code 2.1.139 or newer, Node.js 22.18 or newer and ffmpeg 6 or newer.
