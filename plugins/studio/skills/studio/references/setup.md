# Setup — install, the key, the studio folder and updates
Status: updated for macOS, Windows and Linux — not yet tried on a fresh install
Date: 2026-11-23

How the user installs studio, puts in or changes the fal key, chooses the studio folder and updates the plugin, and what the first-run check means. The user does every step here. Claude explains them and never handles the key value (hard rule 4).

## Install
1. The user installs what studio needs. All three machines need Claude Code 2.1.139 or newer (the plugin's hooks use the exec form of `args`), Node 22.18 or newer (on Node 23, 23.6 or newer; live mode inside Claude Code's sandbox needs 22.21 or newer on Node 22, or 24 or newer — not 23, "Claude Code's sandbox" below) and ffmpeg 6 or newer with `ffprobe`.
   - macOS: `brew install node ffmpeg`
   - Windows: `winget install OpenJS.NodeJS Gyan.FFmpeg`, then quit Claude Code and start it again from a new terminal window (or reopen the app). It needs a real `node.exe` (the installer, nvm-windows, Volta or Scoop), not a `.cmd` shim. Windows needs no Git for Windows (reports welcome). WSL2 counts as Linux.
   - Linux: the Node in a distribution's own packages is older than 22.18 (Ubuntu 24.04 and Debian 12 have 18, Alpine 3.19 has 20), so use the official installers at https://nodejs.org/en/download or a version manager from that page. ffmpeg: on Ubuntu 24.04 and later `sudo apt install ffmpeg` is enough; on another distribution any ffmpeg 6 or newer with `ffprobe`, `libx264` and `aac` will do. `espeak-ng` is optional ("Preview voices and their terms" below).
2. In Claude Code, the user adds the marketplace and installs the plugin:
   ```
   /plugin marketplace add 2yong-k/claude-plugins
   /plugin install studio@2yong-k
   ```
3. The install asks for two values. **Studio folder** — where works, assets, page-price records and lessons are kept (default `~/studio-works`; an absolute path, with its drive on Windows like `C:/…`, or one starting with `~/`). **fal API key** — a masked field. Leave it empty to stay in fake mode.
   A program installed while Claude Code is open, or a PATH changed since, is seen only after the user quits Claude Code and starts it again from a new terminal window (or reopens the app): a new session keeps the environment Claude Code was started with, and the hooks and every command inherit it.
4. The user starts a new session. At every session start the plugin writes the studio folder setting, creates the folder, and stores the key if one was given: in the macOS Keychain on macOS, in an owner-only file on Windows and Linux ("The fal key" below). Then `studio doctor` shows what is still missing.

If the command cannot be found (`${CLAUDE_PLUGIN_ROOT}` is empty or has no `studio.mjs`), the plugin is not installed or enabled, or the session started before the install — start a new session.
If the command prints `studio: Node 22.18 or newer is required…` instead of JSON, the user installs a newer Node, then quits Claude Code and starts it again from a new terminal window (or reopens the app).
If it prints `studio: the drawing package @napi-rs/canvas cannot load on <platform>-<arch>…`, the plugin's packages do not fit this machine: the user reinstalls the plugin or runs `claude plugin update studio@2yong-k`, then restarts Claude Code.
If it prints any other single `studio: …` line instead of JSON (exit code 2), the plugin's install is incomplete: the same fix.

## What `doctor` checks
`studio doctor` returns `home` (the studio folder) and `checks[]`. For each item with `ok: false`, tell the user its `detail` and what to do.

| `id` | What it checks | What the user does when it fails |
|---|---|---|
| `node` | The Node version running studio is 22.18 or newer (23.6 or newer on Node 23) | Install a newer Node, then quit Claude Code and start it again from a new terminal window (or reopen the app) |
| `ffmpeg` | `ffmpeg -version` runs and is 6 or newer, `ffprobe` runs, and the `libx264` and `aac` encoders are there | Install or upgrade ffmpeg as in "Install" above (`brew install ffmpeg`, `winget install Gyan.FFmpeg`, `sudo apt install ffmpeg`). On Windows, a `.cmd` or `.bat` shim of ffmpeg cannot be started: it needs the real `ffmpeg.exe` on PATH. Then quit Claude Code and start it again from a new terminal window (or reopen the app) |
| `home` | The studio folder exists and is writable, or the nearest existing folder above it is | Fix the folder's permissions, or choose another folder with `/plugin configure` and start a new session. Under Claude Code's sandbox, allow the folder ("Claude Code's sandbox" below) |
| `key` | A fal key is stored (presence only, never the value): in the macOS Keychain, or as the key file on Windows and Linux (looked at without opening it) | Needed only for live mode: add the key ("The fal key" below). Fake mode works without it. If `detail` says the file can be read by other users, see `KEY_UNSAFE` in `SKILL.md` |
| `voices` | The voices the preview reads lines with are installed: the macOS voices on macOS, a `ko-KR` and an `en-US` voice on Windows, `espeak-ng` with Korean and English on Linux (`detail` says what is missing). On Windows a language with no voice of one gender still passes, and `detail` names the voice that reads those lines: Windows has no male Korean voice, so male Korean lines are read by the female voice and the preview reports them as `degraded`. That is not a to-do; nothing can be installed for it | Optional, for hearing lines in a preview: add the voice ("Preview voices and their terms" below). Without it a preview still works, and the lines with no voice are previewed silently with estimated timing |

When `doctor` itself fails:
- `CONFIG_INVALID` naming the studio config: the studio folder setting is broken. The user sets the studio folder again with `/plugin configure` and starts a new session.
- `CONFIG_INVALID` saying `no studio folder is set; set the studio folder with /plugin configure`: there is no studio folder setting yet (no session has started since the install, or the session start failed). The same fix: `/plugin configure`, then a new session. If the session start showed a hook error about node, put node on the system PATH, then quit Claude Code and start it again from a new terminal window (or reopen the app): the hooks start the `node` that Claude Code finds on its PATH, and a Claude Code started from a desktop launcher may not see a node that a version manager (nvm, fnm) adds only in a terminal. On Windows it must be a real `node.exe`, not a `.cmd` shim.

## `STUDIO_MODE` left set
studio no longer reads `STUDIO_MODE`: live mode is `studio --live <command>`. While the variable holds any value, every command stops with `MODE_INVALID`, even with `--live`. The user removes it wherever it is set:
- A shell profile (`~/.zshrc`, `~/.bashrc`, `~/.profile` or another file the shell reads at start): delete the line that sets it, and run `unset STUDIO_MODE` in a terminal that is still open.
- Windows: `Remove-Item Env:STUDIO_MODE` clears it in an open PowerShell window. A user variable is deleted in Settings (search for "environment variables", then "Edit environment variables for your account"), or in PowerShell with `[Environment]::SetEnvironmentVariable('STUDIO_MODE', $null, 'User')`.
- Claude Code settings: an `env` entry named `STUDIO_MODE` in `~/.claude/settings.json` or in a project's `.claude/settings.json` or `.claude/settings.local.json`; the user deletes that entry.

Then quit Claude Code and start it again from a new terminal window (or reopen the app): a new session keeps the environment Claude Code was started with.

## The studio folder
`home` holds everything of the user's own:
- `works-fake/` and `works/` — the works of fake and live mode
- `assets/` — reused material ("Making assets" in `SKILL.md`)
- `price-checks.json` — page prices re-checked with `price-check` (`references/estimate.md`)
- `price-check-input.json` — the page price Claude writes for one `price-check`; the command removes it once it has recorded the price
- `lessons.md` — prompt lessons from the user's works (`references/review.md` §6)
- `.lock` — there only while a `price-check` runs (`references/recovery.md` §3)

The plugin folder is replaced on every update, so nothing of the user's is kept there. Claude never deletes anything in the studio folder (hard rule 3).
The setting itself is kept in `config.json` in the studio config folder, `~/.config/studio-plugin/` on every OS (on Windows under the user profile, `%USERPROFILE%\.config\studio-plugin\`). It is written again at every session start and is not edited by hand.
To use another folder, the user changes **Studio folder** with `/plugin configure` and starts a new session. Works already made stay in the old folder; whether to move them is the user's call, and the user moves them.

## The fal key
**Where it is kept.** On macOS, in the macOS Keychain (service `studio-fal`, account `studio`). On Windows and Linux, in an owner-only file, `provider-key.json` in the studio config folder. The file is not encrypted: it is protected like Claude Code's own `.credentials.json`, by the user's profile. The guard refuses the common ways of reading either store (a speed bump, not a barrier).

**Putting it in** — before the first live estimate. The brief and the drawn preview need no key.
1. The user signs up at fal.ai and buys credit (prepaid; fal's terms say credits expire 365 days after purchase).
2. On the fal dashboard's keys page (https://fal.ai/dashboard/keys), **Create Key** with the **API** permission preset (not FULL, which holds every permission on the account but key creation), no model restriction, and an expiry the user notes down. The key is copied at once — it is not shown again.
3. `/plugin configure` → paste the key into the masked **fal API key** field → start a new session. The session start stores it where it is kept (above), replacing any key there. The key goes only into that field, never into the chat, a file or a command line.
4. `studio doctor` → the `key` item is `ok: true`.
5. Only if the user asks for a live check: `studio --live smoke`. It goes only as far as the price lookup for the cheapest single image and makes no generation call.

**Changing it** — before it expires, or at once if it may have leaked. The user issues a new key as above, puts it in the same way, checks with `doctor` (and `smoke` if they want a live check), then revokes the old key on the fal dashboard. If it may have leaked, the user revokes the old key first and looks at the calls made with it on fal.

**Capping what a leak can cost** — optional. fal can alert on one key's daily, weekly or monthly cost and, with **Auto-lock** on, block new requests once the cost reaches the threshold. fal turns spending controls on per account, and locks separately: the user asks fal support first, then adds an alert on the studio key under **Settings → Usage & Billing → Spending Controls** with Auto-lock on.

- An empty key field leaves the stored key alone. To stop using a key, the user revokes it on the fal dashboard, and a key still in the field is stored again at the next session start.
- **Removing the stored copy** — the user clears the key field (or uninstalls the plugin) first, then runs one of these in their own terminal, or in Claude Code with the `!` prefix. On Windows the `!` prefix runs in Git Bash when Git for Windows is installed (unless Claude Code's default shell is set to PowerShell): there, and in any Git Bash window, use the `rm` lines; the PowerShell lines are for a PowerShell window. **These are the user's to run: Claude never runs them, and the guard refuses the file ones from Claude.**
  - macOS: `security delete-generic-password -s studio-fal -a studio`
  - Linux: `rm ~/.config/studio-plugin/provider-key.json`
  - Windows (PowerShell): `Remove-Item "$HOME\.config\studio-plugin\provider-key.json"`
  - The whole config folder, key file and setting together: `rm -r ~/.config/studio-plugin` or, in PowerShell, `Remove-Item -Recurse "$HOME\.config\studio-plugin"`
- If the field was filled but `doctor` still finds no key after a new session, the session start could not store it (a key with a line break inside is refused). The user enters it again.
- If the key file on Windows or Linux could be read by other users, the next session start writes it again so that only the user can read it and shows one line saying so (`the stored key file was readable by others; it is now owner-only — rotate the key if others use this machine`). This works while the key is still saved in the **fal API key** field; if the field is empty, the user enters the key again. Until then live commands give `KEY_UNSAFE`. If other people use the machine, the user rotates the key.
- Windows and Linux users who saved a key under version 0.1 never had it stored (the session hook could not run there). The first session of a newer version stores it from the saved setting; the user acts only if a live command says `KEY_MISSING`, and then enters the key again.
- A 403 from fal points to a key without enough permission: the user issues a new one with the API preset.

Claude never reads the key or the key file. A guard hook refuses the common ways of reading it, but it is a speed bump, not a barrier — hard rule 4 is what binds Claude.

## Updates
- Automatic: `/plugin` → Marketplaces → `2yong-k` → Enable auto-update.
- By hand, in a terminal:
  ```bash
  claude plugin update studio@2yong-k
  ```
  Then `/reload-plugins` in the open session (or restart Claude Code) loads the new version.
- The studio folder and the plugin settings stay as they are. An update may bring new bundled prices and models; the user's own page-price records still count when they were checked on the same day as the bundled price or later.
- Update between works: an update in the middle of a work can make its finished elements unfinished again (`references/recovery.md` §5). Update, reload or, with auto-update on, restart Claude Code between works where possible.
- A new major version means the user has something to do; its entry in the changelog (https://github.com/2yong-k/studio/blob/main/CHANGELOG.md) says what.

## Claude Code's sandbox
When the user turns on Claude Code's sandbox (`/sandbox`, or `sandbox.enabled` in their settings; macOS, Linux and WSL2 — native Windows runs commands unsandboxed), every `studio` command runs inside it. A sandboxed command writes only in the session's working folder, a temp folder and folders the user has added, and reaches only hosts the user has allowed. A plugin cannot change that, so the user adds two entries to their own `~/.claude/settings.json` and starts a new session:
```json
{
  "sandbox": {
    "filesystem": { "allowWrite": ["~/studio-works"] },
    "network": { "allowedDomains": ["*.fal.run", "*.fal.ai", "fal.media", "*.fal.media"] }
  }
}
```
- `allowWrite` holds the studio folder (`home` in `doctor`'s output; `~/` starts at the user's home folder). Without it `doctor`'s `home` check says `… is not writable`, and commands stop with `UNEXPECTED` on a path in the studio folder: `EPERM: operation not permitted` on macOS, `EROFS: read-only file system` on Linux and WSL2. On Linux and WSL2 an entry has no effect until the folder exists; a session start creates it. Not needed when the studio folder is inside the session's working folder.
- `allowedDomains` is for live mode: fal's API and file hosts, allowed together. A host that is not allowed makes the session ask or refuse, depending on the permission mode; a refusal gives `PROVIDER_ERROR` with `the request did not complete` and `Request was cancelled`. In `generate` a refused or long-unanswered question about the queue host gives `ATTEMPT_UNRESOLVED` instead and leaves the attempt in `submitting` (`references/recovery.md` §1). A picture upload goes to an address fal gives at that moment; if the session asks about another host while `generate` uploads, that is it, and a refusal there stops before anything is sent.
- Live mode inside the sandbox needs Node 22.21 or newer on Node 22, or Node 24 or newer: studio sends its requests through the sandbox's proxy only there. On an older Node, or Node 23, live commands fail even with the hosts allowed: `PROVIDER_ERROR` naming `ENOTFOUND` on macOS, `EAI_AGAIN` on Linux and WSL2 (from the docs, not tried), or `ATTEMPT_UNRESOLVED` at a `generate` submit as above.

## Preview voices and their terms
`preview` reads a work's lines with the voices the machine already has: `say` on macOS, the built-in voices (SAPI) on Windows and `espeak-ng` on Linux. A line containing Hangul gets a Korean voice and any other line an English one, male or female as the brief says (on Windows and Linux the voices are chosen by language and gender; a missing gender is read by another voice of that language and reported as `degraded`). A line the machine has no voice for is previewed silently, with its timing estimated from the text; `voice` in the `preview` output and the `voices` item of `doctor` name what is missing (`references/preview.md`).
- **Adding a voice** — the user does it; the next `preview` picks it up.
  - macOS: System Settings → Accessibility → Spoken Content → System voice → Manage Voices.
  - Windows: install the Korean language pack in Windows Settings (Time & language), which brings the `ko-KR` voice. The English voices come with Windows. Only offline voices are used. Windows has no male Korean voice, so male Korean lines are read by the female voice and the preview marks them `degraded`; there is nothing to install for that.
  - Linux: install `espeak-ng` with the distribution's package manager: `sudo apt install espeak-ng`, `sudo dnf install espeak-ng`, `sudo pacman -S espeak-ng` or `sudo apk add espeak-ng`. Its voice is robotic and its Korean is rudimentary: good enough for timing and the mouth, not for judging delivery.
- **Terms.** The macOS licence allows its system voices for personal, non-commercial use only, and not for recordings in a commercial context. Microsoft gives no commercial statement for its voices, so the Windows voices are treated the same way. `espeak-ng` is free software under the GPL-3.0 or later; none of it ships with studio. So a voice is used only in the preview, which stays on the machine and never goes into a finished work. Never publish a preview or its sound (hard rule 5).

## For the maintainer only
- `price <endpoint…>` and adding a model to the bundled `data/models.json` are the plugin maintainer's work. Users do not add models; new models and prices arrive with updates. If the user wants a model that is not in the list, tell them it is not available in this plugin.
