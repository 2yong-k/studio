# studio

A Claude Code plugin for making images and videos by asking Claude in plain words. Claude settles a brief with you by asking questions, shows a free drawn preview, prices the work, and generates only after you approve that estimate in the conversation. Then it puts the work together and reviews it with you.

## Requirements
- macOS, Windows or Linux (including WSL2). On macOS the key is kept in the macOS Keychain; on Windows and Linux it is kept in an owner-only file, `provider-key.json` in the studio config folder (`~/.config/studio-plugin/`). Previews read lines with the machine's own voices: macOS voices, Windows' built-in voices or `espeak-ng` on Linux. A line with no voice is previewed silently, with estimated timing.
- Claude Code 2.1.139 or newer
- Node.js 22.18 or newer (on Node 23, 23.6 or newer)
- ffmpeg 6 or newer, with `ffprobe` and the `libx264` and `aac` encoders

Install them with:
- macOS: `brew install node ffmpeg`
- Windows: `winget install OpenJS.NodeJS Gyan.FFmpeg`, then quit Claude Code and start it again from a new terminal window (or reopen the app), so it sees the new PATH. It needs a real `node.exe` (installer, nvm-windows, Volta or Scoop), not a `.cmd` shim. Windows needs no Git for Windows (reports welcome).
- Linux: the Node in a distribution's own packages is older than 22.18 (Ubuntu 24.04 and Debian 12 have 18, Alpine 3.19 has 20), so use the official installers at https://nodejs.org/en/download or a version manager from that page. For ffmpeg on Ubuntu 24.04 and later, `sudo apt install ffmpeg` is enough. Optional: `espeak-ng`, to hear the lines of a preview.

## Install
In Claude Code:

```
/plugin marketplace add 2yong-k/claude-plugins
/plugin install studio@2yong-k
```

The `2yong-k` marketplace lists every plugin by 2yong-k; this repository holds the studio plugin.

Then start a new session and ask Claude to run `studio doctor`; it lists anything still missing. If you installed Node or ffmpeg while Claude Code was open, quit Claude Code and start it again from a new terminal window (or reopen the app) instead: a new session keeps the PATH Claude Code was started with.

## Use it
Ask Claude for an image or a video in plain words, in any language. For example:

> Make a 10-second vertical video of a paper boat drifting down a rainy street, for a Shorts intro.

You can also start it by name with `/studio:studio`. Every work goes through the same steps:
1. **Brief.** Claude asks a few questions (what it is for, the size and length, the look) and writes the answers into the work's brief.
2. **Free preview.** A rough drawn video (for an image, a preview of the shapes) checks the layout and timing before any money is spent. For a video, the lines, actions and scenes are settled here.
3. **Estimate.** Claude prices every generation the work needs, tells you what dropping a part would save, and waits until you approve the estimate in the conversation.
4. **Generate.** Images, and the keyframes a video starts from, are made first. For a video you confirm the keyframes on a contact sheet, and only then are the video clips made from them.
5. **Put together and review.** studio adds drawn text and captions, assembles the work with ffmpeg, and goes over it with you. A clear defect is made again; when you are happy, the work is finished.

## Fake mode and live mode
Right after install, studio runs in fake mode: stand-in images and videos are made on your machine, with no key, no network and no money spent. You can try the whole flow (brief, preview, estimate, approval, generation, assembly) this way. Live mode is used only for a real work you ask for, and even then nothing is generated until you approve its estimate in the conversation.

Live mode uses image and video models on [fal.ai](https://fal.ai), which bills your own fal.ai account. To turn it on, create an API key in your fal.ai account and add it as described below. Every generation call has a time limit and a cost cap, and each call is written to the work's `spend.jsonl`. The bundled models and their prices are in `plugins/studio/data/models.json`.

## The studio folder and the key
The install asks for two values. Change them later with `/plugin configure`, then start a new session.
- **Studio folder**: where your works, assets, price records and prompt lessons are kept (default `~/studio-works`). The plugin folder is replaced on every update, so nothing of yours is kept there.
- **fal API key**: needed only for live mode, which spends money on [fal.ai](https://fal.ai). Leave it empty to stay in fake mode. Put the key only into this masked field, never into the chat, a file or a command line. At each session start the plugin stores it: in the macOS Keychain on macOS, or in an owner-only file, `provider-key.json` in the studio config folder, on Windows and Linux.

Inside the studio folder:
- `works/`: one folder per live work, named by date (`2026-11-19-paper-boat`). It holds the brief, the estimate, your approvals, the spend record, the generated files and the finished versions in `final/`.
- `works-fake/`: the same for fake-mode works.
- `assets/`: people, styles and fonts you reuse across works.
- `price-checks.json`: model prices you re-checked on the model's page.
- `lessons.md`: prompt lessons from your finished works, read before the next one.

## What leaves your machine
- Fake mode, previews, assembly and review run on your machine only.
- In live mode, studio talks only to fal.ai: it looks up model prices, uploads the reference pictures and frames a generation uses, sends the requests you approved, and downloads the results.
- The key stays in the macOS Keychain, or in the owner-only key file on Windows and Linux (not encrypted: it is protected like Claude Code's own `.credentials.json`), and is read only when a call is made. A hook refuses the common ways of reading either into the conversation (a speed bump, not a barrier).
- As in any Claude Code session, what Claude reads (your messages, and the frames and contact sheets it reviews) goes to Anthropic.

## Update
Either turn on auto-update: `/plugin` → Marketplaces → 2yong-k → Enable auto-update. Or update by hand:

```
claude plugin update studio@2yong-k
```

Then run `/reload-plugins` in the open session (or restart Claude Code) to load the new version.

- Your studio folder and plugin settings stay as they are, and works made by an earlier version still open.
- Update between works: an update in the middle of a work can make its finished parts count as unfinished, so they are made, and paid for, again. Update, reload or, with auto-update on, restart Claude Code between works where you can.
- A new major version means you have something to do; its entry in `CHANGELOG.md` says what.

## Uninstall
`/plugin uninstall studio@2yong-k` removes the plugin itself. Removing the marketplace `2yong-k` uninstalls it too and clears its settings; adding the marketplace back restores neither, so install studio again and set the studio folder again if it was not the default. These stay until you remove them:
- **The key.** Remove it yourself, in your own terminal (not through Claude), after clearing the **fal API key** field in `/plugin configure` or uninstalling, since a key still in the field is stored again at the next session start. It does not print the key.
  - macOS, the Keychain item `studio-fal` (account `studio`): `security delete-generic-password -s studio-fal -a studio`
  - Linux: `rm ~/.config/studio-plugin/provider-key.json`
  - Windows (PowerShell): `Remove-Item "$HOME\.config\studio-plugin\provider-key.json"`
- **The settings folder** `~/.config/studio-plugin/`, which holds `config.json` (it points studio at your studio folder) and, on Windows and Linux, the key file. Remove it all with `rm -r ~/.config/studio-plugin`, or in PowerShell `Remove-Item -Recurse "$HOME\.config\studio-plugin"`.
- **Your studio folder** (default `~/studio-works`), with your works, assets, price records and prompt lessons. It is yours to keep or delete.

## Preview voices
`preview` reads a work's lines aloud with voices the machine already has: `say` on macOS, the built-in voices (SAPI) on Windows and `espeak-ng` on Linux. A line with no voice (for example Korean on a Windows without the Korean language pack) is previewed silently, with its timing estimated from the text, and the preview says so. To hear it, add a voice: on macOS in System Settings → Accessibility → Spoken Content → System voice → Manage Voices, on Windows by installing the Korean language pack, on Linux with `sudo apt install espeak-ng` (or `dnf`, `pacman -S`, `apk add`). The Linux voice is robotic and its Korean is rudimentary.

The macOS licence allows its system voices for personal, non-commercial use only, and not for recordings in a commercial context. Microsoft gives no commercial statement for its voices, so the Windows voices are treated the same way, and nothing of `espeak-ng` ships with studio. studio uses voices only in the preview, which stays on the machine and never goes into a finished work. Do not publish a preview or its sound.

## License
MIT (see `LICENSE`; `plugins/studio/LICENSE` is the same text, so an install carries it). The bundled fonts in `plugins/studio/fonts/` keep their own license, the SIL Open Font License 1.1.
