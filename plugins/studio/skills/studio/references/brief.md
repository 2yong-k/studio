# Brief — finish the design by asking questions
Status: in use
Date: 2026-10-29

Generation costs money and a video is many times more expensive than an image. So before generating, finish the brief by asking questions, so that it comes out right in one pass. This step starts with `studio new <name> --kind image|video` and consists of filling in `brief.json`. A name uses only lowercase letters, digits and `-`. The folder is created as `YYYY-MM-DD-<name>` (local date), with `inputs/` and a `brief.json` skeleton created together. You find the locations from `work`, `dir` and `brief` in the output.

## How to ask
- One question per message. Attach a **recommendation and the reason** to every question ("I would do it this way — the reason is…"). The user should be able to answer in a single phrase such as "go with that".
- If the answer is already in the request, do not ask; only confirm.
- The order is as below. Earlier answers narrow later questions.

| Order | What to ask | Where it fills in the brief |
|---|---|---|
| 1 What | What, for whom, and why. Image or video, and where it will be posted (size, vertical or horizontal) | `intent`, `kind`, `frame` |
| 2 Feel | A mood in a sentence or two. If there is a work to refer to, take it | `mood` |
| 3 People | Is there a person in it. If so, must the same person carry through (is there a hero sheet in `assets/`) | `prompt` and `refs` of generated elements, `assets` |
| 4 Text | Confirm the wording that goes on screen, without a single character wrong. When it appears and disappears | `method: "draw"` elements, `enterMs`, `exitMs` and `anim` of the box |
| 5 Layout | What goes where on the screen. For video, the order and length of cuts and the camera movement | `layout` (image) / `cuts[].layout` (video), `parts`, `camera` |
| 6 Background | Is the background generated, or does it use a file you have | A generated element, or a `composite` or `capture` element |
| 7 How each element is made | Decide one way of making each element | `method` of the element |
| 8 Lines and actions (video works, optional) | The lines a person says, the actions to be called out and their times | `speech`, `beats` and `scene` of a generated video element |

The 4 ways of making:
- `generate` — the generation service makes it. Money goes out.
- `draw` — drawn by code (text, shapes). Free, and the text cannot come out wrong. **Do not generate text; draw it with `draw`.**
- `capture` — a screenshot or screen recording the user gave (`inputs/`). A video is cut to the length of the visible stretch and its sound is included by default (with `keepAudio: false` it is left out; if there is no sound track it is silent).
- `composite` — lays an existing file on as it is (a logo, a brand kit, the user's photo).

When you finish 7 (through 8 if a video work has a person who speaks or an action to be called out), write `brief.json` and go straight to `preview` (`references/preview.md`). 8 is the `speech`, `beats` and `scene` below, and the line sentence must also be in `prompt` exactly. Brief validation is the very first thing `preview` and `estimate` do. The layout guide image of an element that uses `layoutRef` is a file `preview` wrote, so before `estimate` you must have run `preview` with the current brief (if there is a `layoutRef` element and you did not run it, `BRIEF_INVALID` comes and tells you to `preview` first). If you fixed the layout, run it again every time — if you do not, it is refused with `BRIEF_INVALID` (`run preview again`) because the picture is old.

## Models you can use
Read `data/models.json` in the plugin folder that SKILL.md names. In `models[]`, each entry gives its `id`, `output`, `fps` and `use`. This bundled list is read-only: every update replaces it.

**The default video model is `happy-horse-11` (Happy Horse 1.1).** Recommend this first, whether or not there are lines. Adding a model is the plugin maintainer's job, and new models arrive with updates. If one comes that is cheaper and good in quality, compare it and ask the user before switching.

The model id, size, allowed lengths and reference image slots are set by `data/models.json`. The values in the brief must be within its limits.
- A model with no commercial-use confirmation (`commercialUse`) is refused with `BRIEF_INVALID`, and `error.details.issues[].code` is `MODEL_NOT_ALLOWED` (`path`: `elements.N.model`).
- A model whose pixel size list is empty is refused with `BRIEF_INVALID` (`model … has no size for …`). Do not choose it before the list is filled in.

## Fields
The Zod schema (`<plugin folder>/src/works/brief.ts`) is the reference, and unknown fields are refused. Coordinates are integer pixels `[x, y, w, h]` in the work's frame, and times are integer ms.

| Field | Meaning |
|---|---|
| `schema` | Always `1` |
| `work` | Must equal the folder name (`new` fills it in) |
| `kind` | `image` or `video` |
| `intent`, `mood` | Must not be empty. The skeleton `new` makes is empty, so it does not pass as it is |
| `frame` | `{ width, height }`, and for video `fps` too. The video `fps` is the `fps` of the generation video model (`data/models.json`). If you mix models with different fps, ask the user to pick one of them. If they differ, `estimate` stops with `BRIEF_INVALID` |
| `assets` | The asset folders used (optional). Example: `["assets/hero"]` |
| `elements[]` | The list of elements. Below |
| `layout[]` | The boxes of an image work |
| `cuts[]` | The cuts of a video work. Each cut has `id`, `durationMs`, `layout` and (optional) `camera` |
| `audio` | Background music (optional) `{ "music": "assets/music/…", "gainDb": -12 }`. A music file must have an `asset.json` license |

**Elements (`elements[]`)** — common `id`, `label`, `method`.
- Image generation: `output: "image"` · `model` · `prompt` · `refs` (reference image paths, optional) · `layoutRef` (pass the shape layout as a reference image, optional) · `size` (`[w, h]`, optional)
- Video generation: `output: "video"` · `model` · `prompt` (write the motion) · `from` (the id of a keyframe image element) or `fromFile` (the path of an existing picture file; exactly one of the two) · `toFile` (the last-frame picture file, optional — only when the model has a last-frame slot. For a looping video, the same file as `fromFile`) · `durationMs` · `keepAudio` (whether to use the generated sound; by default it is included — with `false` it is left out) · `size`
- The **three optional fields** of video generation (all three may be left out). They are used only on a generated video element, and writing them on another element is refused. They are for the drawn video preview and do not change the generation input fingerprint.
  - `speech` — `{ "voice": "male"|"female", "lines": [{ "text", "atMs" }] }`. It is what the person says in that clip. There is one voice per element (one clip has only one person speaking). `atMs` is clip time (the first frame is 0) and `lines` has at least one.
  - `beats[]` — an action the user will call out. `id`, `label` and `at` are required; `offsetMs` (integer, may be negative, default 0) and `durationMs` (a positive integer; if absent, an instant) are optional. It has **exactly one** of `prompt` (the sentence, exactly as it is, inside the element's `prompt` that describes the action) and `previewOnly: true`. `previewOnly` shows only on the time strip and is not tied to the prompt.
    - `at` is one of: `{ "word": "<word>" }` (the time when the first word containing that word starts to be pronounced. A word is a space-separated unit, with punctuation removed. If there are several lines, from the earlier lines) · `{ "lineEnd": <line number> }` (the time when that line's sound ends) · `{ "ms": <clip time> }` (an action unrelated to the lines).
  - `scene` — the scene file that draws this element. A `.mjs` inside the work folder (for example `scenes/take-plate.mjs`). How to use it is in `references/scenes.md`.
```json
{ "id": "take-plate", "scene": "scenes/take-plate.mjs",
  "speech": { "voice": "male", "lines": [{ "text": "I start this morning with this coffee.", "atMs": 500 }] },
  "beats": [
    { "id": "lift", "label": "Lift the cup", "at": { "word": "coffee" }, "durationMs": 550,
      "prompt": "As he says \"this coffee\", at about 1.5 seconds, he lifts the coffee cup a little toward the lens." },
    { "id": "smile", "label": "Smile", "at": { "lineEnd": 0 }, "offsetMs": 100, "previewOnly": true }
  ] }
```
- Text and shape `draw`: `color` + exactly one — `text` (+ `font`, `sizePx`, `align`, `valign`, `letterSpacingPx`, `lineHeightPx`) or `shape` (`rect`, `roundRect`, `line`, `arrow`, `circle`). `color` is a CSS color (`#FFFFFF`, `#00000066`, `rgba(0, 0, 0, 0.4)`, `black`). A value the canvas does not know is `BRIEF_INVALID` (`elements.N.color`). `align` (`left` by default, `center`, `right`) is horizontal alignment by text width, and `valign` is `top` (the default, drawn from the top of the box) or `middle` (puts the height the lines actually paint at the vertical center of the box). `letterSpacingPx` (integer, may be negative, default 0) is the spacing added per character, and the line-break, overflow and overlap checks also measure with this value. `lineHeightPx` (a positive integer, default `round(sizePx × 1.3)`) is the distance between lines. If you leave out `sizePx`, it is 5% of the frame's shorter side (rounded), and if you leave out `font`, it is `pretendard-regular`. A value set in em is written converted to px — −0.025em at 80px is −2, and 1.2em is 96
- The optional field `mark` of text `draw` — `{ "text", "color", "textColor" }`. It lays a Mark band (a slanted parallelogram band) under one phrase in `text` and uses `textColor` for that phrase. Both are CSS colors and are required. The band is 1.15em high and independent of `lineHeightPx`, and the phrase takes its own width + 0.4em in the line flow. The phrase is treated as one piece at a line break and is not split (if it is wider than the box, `cut_off`). The band is also text extent, so it goes through the overflow and overlap checks. If the user keeps notes on their own brand in their assets (for example `assets/<brand>/README.md` in the studio folder), take the mark colors and sizes from there.
- Captions: put a translucent band (`shape`) and the text box on **the same `rect`**, and use `align: "center"` and `valign: "middle"` on the text. Then the caption sits at the center of the band, vertically and horizontally
- `capture` and `composite`: `file` · (video files only) `keepAudio` (an imported video includes sound by default, and `false` leaves it out. Writing it on an image file is `BRIEF_INVALID`. A file with no sound track is silent)
- The `file` of a `composite` can also be `.svg` (a logo, a wordmark). `make` draws it at the exact pixel size of the box, so it is sharp at every size. If the SVG uses `currentColor`, write `color` (a CSS color) and it becomes that color. `capture` does not accept SVG (it is a screenshot or screen recording). The rules are in the validation section below

**Boxes (`layout[]`, `cuts[].layout[]`)** — `element`, `rect`, `z`, and optionally `parts[]` (the layout inside the box: a label and a `rect`), `enterMs`, `exitMs`, `anim` (`fade`|`slide`).
- `fit` (optional, `[x, y, w, h]` in frame coordinates, inside the box `rect`) — used only on a still picture on a chosen paper or flat-color background (a `generate` image, an image `composite` or `capture`). `make` measures the outline of the object in the picture and shrinks it (it does not enlarge it) to fit in the center of `fit`, and fills the leftover space by flipping and continuing the blank paper of that picture. It is independent of the generation fingerprint, the guide image and approval, so you add or fix it after generation and run `make` right away. Place that element in only one box. If the object cannot be found, the blank paper to continue with is narrow, or `fit` is small so that the shrunk blank paper is under 32px on a side, it is `BRIEF_INVALID` (`<box path>.fit`) — remove `fit` or widen it.
**Camera** — `{ mode: "prompt" | "digital", from: rect, to: rect, ease: "linear" | "inOut" }`. `prompt` asks for the motion in the generation prompt and does not apply it again at compositing. With `digital`, `make` crops the whole cut and zooms and pans. The only cut transition is a straight cut.

## Rules that often catch in validation
- A video generation element points with `from` at **one image generation element (a keyframe)**, or uses with `fromFile` an **imported keyframe** (an existing picture file). Exactly one of the two. One generated keyframe is used by only one video. A keyframe is not placed in `layout` (placing it is refused).
- `fromFile` accepts only `assets/…` or this work's `inputs/…` (anywhere else, such as `raw/`, is refused — so that 5b cannot be skipped with an unconfirmed generation result). It must actually exist and only png, jpeg and webp are allowed (the extension is case-insensitive). Its pixel size must be readable from the file header: an animated WebP, or a file whose header cannot be followed, is refused as `elements.N.fromFile` (`<file> has no readable picture size`) — save the chosen picture again as a still png, jpeg or webp. Several videos may use the same file. An imported keyframe has no 5b confirmation and is made directly in the first `generate`. If the file changes, that video becomes unfinished again, but the approval is not tied to the file contents (the same as `refs`). In `fromFile`, write only a picture the user saw and chose in the conversation. Do not copy an unconfirmed `raw/` result of this or another work into `inputs/` to use it (the code refuses every path outside `assets/` and `inputs/` and every link into `raw/`, but it cannot recognise a copy). Only when the picture the user chose is the result of another work, copy that file into the new work's `inputs/` (leave the original as it is) and write the source (the work and attempt path) in the element `label`.
- `toFile` (the last frame) has the same path and size rules as `fromFile` (under `assets/` or `inputs/`, png, jpeg or webp with a readable pixel size, only a picture the user chose). If the model's `slots.lastFrame` is `null`, it is refused as `elements.N.toFile` (`model … has no last-frame slot`) — the models that take a last frame now are `wan-30`, `minimax-h3` and `seedance-25`. If the aspect ratios of the first and last pictures differ (the widths differ by more than 1px at the smaller picture's size), the brief check refuses it as `elements.N.toFile`, so `preview` and `estimate` stop before any approval. The ratio is taken from the pixel size stored in the file, not from a phone photo's rotation mark. With a generated keyframe (`from`), or a file changed after the estimate, `generate` checks again before the upload — no money goes out. The last-frame file contents also go into the generation fingerprint, so changing it makes that video unfinished again.
- Rules of `speech`, `beats` and `scene` (all `BRIEF_INVALID`, with `error.details.issues[].path` being `elements.N.speech…`, `elements.N.beats.K…`, `elements.N.scene`):
  - `speech.lines[].text` must be in the element `prompt` exactly, character for character. `lines[].atMs` must be less than `durationMs`. If you fix a line only in the prompt or only in `speech`, it catches here.
  - `beats[].prompt` must be in the element `prompt` exactly, character for character. Exactly one of `prompt` and `previewOnly`. `beats[].id` must not repeat.
  - If an `at.word` action has a `prompt` sentence, that sentence must contain that word (`the sentence does not contain the word …`). The word must be in some line (`no word contains "…"`, with the per-line word list shown), and the line number of `at.lineEnd` must exist.
  - `scene` is a `.mjs` and must not be under `assets/`. The file must actually be inside the work folder.
  - What the code cannot see: whether `offsetMs`, `durationMs`, or the time based on `ms` or `lineEnd` matches the seconds expression in the `prompt` sentence. The length of the line sound can be known only at render time, so lines overlapping each other or running past the clip is not an error but a `preview` warning (`speech_overlap`, `past_clip`). When you fix a time, fix that sentence too (`references/preview.md`).
- A generated element that is not in `layout` is allowed only if it is a keyframe. Place a generated element only once.
- A video's `cuts` has at least one (the skeleton from `new` is empty). Element and cut `id`s must not repeat. A box's `element` must be in `elements[].id`, `exitMs` must be at most the cut `durationMs`, and `enterMs` must be before the end time (`exitMs` or the cut length).
- Video elements (generated video, and `capture` or `composite` that are video files) are placed only in a `kind: "video"` brief. Placed in an image brief, they are refused as `elements.N.output` or `elements.N.file`.
- A video `durationMs` is one of the model's allowed lengths, and must not be shorter than the stretch where that element is visible in the cut (by default the whole cut, or the stretch `enterMs` to `exitMs` if present). A video model with no first-frame slot is refused.
- The `z` of a video layer (generated video, and `capture` or `composite` that are video files) must be lower than the `z` of every other layer.
- The number of reference images (the count of `refs` + 1 for `layoutRef`) must be within the model slot's minimum to maximum. A model with no reference slot allows only 0. `layoutRef` is used only for image generation.
- The generation size is set from the box `rect` (the closest of the allowed aspect ratios). To make it different, write `size` on the element.
- A file path must be `assets/…` (the `assets/` of the studio folder) or inside this work folder (`inputs/…`) and must actually exist. Going outside with `..` or a symbolic link is refused.
- A file named png, jpeg or webp must have first bytes of that format (`<file> is not a png image`), and a folder is refused (`is not a file`). The renderer and the model look at the contents, not the name, so this stops an SVG renamed to `.png` from skipping the SVG checks. `refs` accepts only png, jpeg and webp (`elements.N.refs.K`).
- SVG `composite` (all `BRIEF_INVALID`):
  - The box aspect ratio must be within ±1px of the SVG aspect ratio (the width and height of `viewBox`, or the root `width` and `height` if there is none). Otherwise it is `<box path>.rect` and the reason gives the matching height (`wordmark.svg is 2800:600; a 140 px wide box needs height 30`). `fit` cannot be used on an SVG box (`<box path>.fit`).
  - An SVG that uses `currentColor` must have `color`, and an SVG that does not, or a file that is not an SVG, must not have it (`elements.N.color`).
  - It is refused if it reads from outside or has anything that would draw differently on each machine (`elements.N.file`, with the piece found in the reason): `<script`, `<foreignObject`, `<image`, `<feImage`, `<style`, `<text` (even with a namespace prefix like `<s:text`) · `<!DOCTYPE`, `<!ENTITY`, `<?xml-stylesheet` · an `href` that does not start with `#` · a `url(…)` that does not start with `#` · `@import` · a character reference `&#` · a backslash · over 1MB · text that is not UTF-8. It is refused even inside a comment. A logo that has text is accepted only as an SVG converted to outlines.
  - It is refused if the size cannot be read (both missing, 0, %, em) or the root tag cannot be read. Root attributes are read by their exact name (`viewbox` is not `viewBox`).
  - When the brief is read, the SVG is actually drawn for each box at the same size and color as `make`. If the renderer cannot draw it (an unclosed tag, a duplicate attribute, a prefixed root and so on), it stops early in `preview` and `estimate` with `elements.N.file` (`<file> cannot be drawn: …`).
- `mark` (all `BRIEF_INVALID`): `mark.text` must appear in `text` **exactly once as a whole word** (with no letter or digit right before or after it — `coffee` does not match `Coffees`, and `HOME` in `HOME.` does match). It must not contain a line break, and must not have blanks at its start or end (`elements.N.mark.text`). In Korean, a word with its particle attached counts as one word, so the particle goes in `mark.text` too (a noun is written together with the object particle that follows it). `mark.color` and `mark.textColor` are CSS colors (`elements.N.mark.color`, `…textColor`). `mark` cannot be put on a shape (`shape`) (`elements.N.mark`).
- The bundled fonts are `pretendard-regular`, `pretendard-bold`, `inter-regular` and `instrument-serif-regular` (the last two have Latin letters only), and they need no record. Other fonts (`assets/fonts/…` in the studio folder) and music need an `asset.json` license.
- If the `text` of a text element (and the `label` of an element that uses `layoutRef`, and the labels of a box's `parts`) has a character the font cannot draw, it is refused with `BRIEF_INVALID` before the price lookup. Here `details` is not `issues[]` but a list `[{ element, field, chars }]` — remove or change the characters in `chars`.
- Fix any other refusal as the `path` (like `elements.0.size`) and `reason` in `error.details.issues[]` say, and call again.

## Example 1 — an image brief (square poster)
This is how it looks filled in, starting from `new poster --kind image`. It is a brief that passed through `preview`, `estimate` and `generate` in fake mode. The `work` of both examples is an example date, so copying it as it is would be refused — use the folder name `new` made. It has a `layoutRef: true` element, so run `preview` before `estimate`.
```json
{
  "schema": 1,
  "work": "2026-10-29-poster",
  "kind": "image",
  "intent": "A square poster announcing a neighborhood roastery's new autumn menu. For an Instagram feed.",
  "mood": "Warm and calm. An autumn tone with a paper texture.",
  "frame": { "width": 1080, "height": 1080 },
  "elements": [
    {
      "id": "hero",
      "label": "Latte photo",
      "method": "generate",
      "output": "image",
      "model": "gpt-25-flare",
      "prompt": "A latte with leaf-shaped milk art on a warm wooden table, autumn morning light, soft paper texture, top-down view",
      "layoutRef": true
    },
    {
      "id": "title",
      "label": "Title",
      "method": "draw",
      "text": "New autumn menu",
      "font": "pretendard-bold",
      "sizePx": 96,
      "color": "#FFFFFF",
      "align": "center"
    }
  ],
  "layout": [
    {
      "element": "hero",
      "rect": [0, 0, 1080, 1080],
      "z": 0,
      "parts": [{ "label": "Latte cup", "rect": [290, 330, 500, 500] }]
    },
    { "element": "title", "rect": [80, 100, 920, 200], "z": 10 }
  ]
}
```
The photo is generated and the text is drawn. `gpt-25-flare` needs at least 1 reference image, so the slot was filled with `layoutRef: true` (one shape layout image).

## Example 2 — a video brief (5-second vertical reel)
This is how it looks starting from `new pilot --kind video`. The structure is one video element = one keyframe + one video + the cut's `layout`.
```json
{
  "schema": 1,
  "work": "2026-10-29-pilot",
  "kind": "video",
  "intent": "A 5-second vertical video announcing a new coffee bean subscription. For Instagram Reels.",
  "mood": "Warm and calm. A tone like morning sunlight.",
  "frame": { "width": 1080, "height": 1920, "fps": 24 },
  "elements": [
    {
      "id": "c1-key",
      "label": "Cut 1 keyframe",
      "method": "generate",
      "output": "image",
      "model": "gpt-25-flare",
      "prompt": "A steaming cup of coffee on a wooden table by a sunlit window, warm morning light, shallow depth of field",
      "layoutRef": true
    },
    {
      "id": "c1-plate",
      "label": "Cut 1 background and coffee",
      "method": "generate",
      "output": "video",
      "model": "happy-horse-11",
      "prompt": "Steam rises slowly from the cup; the light shifts gently. Static camera.",
      "from": "c1-key",
      "durationMs": 5000
    },
    {
      "id": "title",
      "label": "Title",
      "method": "draw",
      "text": "Subscribe to your mornings",
      "font": "pretendard-bold",
      "sizePx": 96,
      "color": "#FFFFFF",
      "align": "center"
    }
  ],
  "cuts": [
    {
      "id": "c1",
      "durationMs": 5000,
      "layout": [
        {
          "element": "c1-plate",
          "rect": [0, 0, 1080, 1920],
          "z": 0,
          "parts": [{ "label": "Coffee cup", "rect": [290, 800, 500, 500] }]
        },
        { "element": "title", "rect": [80, 200, 920, 200], "z": 10, "enterMs": 500, "exitMs": 4500, "anim": "fade" }
      ]
    }
  ]
}
```
The keyframe (`c1-key`) is not placed in `layout`, and the layout reference is cropped from the box of the video element that uses it (`c1-plate`). For a work that uses assets, add `assets`, `audio` and `composite` elements as the field table above says.
