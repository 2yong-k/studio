# Shape video and rough drawn video — look first, with no money
Status: in use
Date: 2026-11-11

This is the step where, before generating, you check for free the cut order, lengths, layout, camera, text positions and wording, and how each element is made. You can repeat it any number of times with no money going out and no approval needed.
For a video work, even the actions and lines of the generated video elements are previewed as a **rough drawn video** (see "Flow for a video work" below). An element with no scene (`scene`) stays as shapes.

```bash
studio preview <work>
```

## What comes out
| Output field | File | Contents |
|---|---|---|
| `video` | `preview/preview.mp4` | The shape and rough drawn video. Made quickly at half the frame size. If there is music, it is included. `null` for an image work |
| `frames` | `preview/<cut>.png` (for an image work, `preview/frame.png`) | The first frame of each cut. Full size, with no legend or time strip. A scene is drawn at `t = 0` |
| `layoutRefs` | `preview/ref-<element>.png` | The image passed as a layout reference to an image generation element with `layoutRef: true` (that box cropped from that cut, with only the `parts` drawn) |
| `voice` | — | `null` when the preview spoke no line; otherwise the engine, how many lines a voice read and how many were estimated, and the voices that were missing or replaced ("What `voice` says" below) |
| `warnings` | — | A list of warnings `{ element, kind }`. Text: `cut_off` (cut off) · `overlap` (overlapping) · `too_small` (too small). Lines and actions: `speech_overlap` (a line overlaps the next line) · `past_clip` (the line sound or action runs past the end of the clip or the visible stretch) · `voice_estimated` (a line of the element was previewed silently, with timing estimated from the text) |

All paths are absolute. The pictures are drawn like this.
- On a neutral background, generate, capture and composite elements are drawn as shapes in a color set per way of making, with a name tag (`label`), and `parts` as small shapes and name tags inside them. In the lower left corner a legend of the colors per way of making sits on a dark strip and hides that spot (when every generate, capture and composite element is drawn as a scene, the legend is left out). Read times from the time under the cells of the contact sheet (`sheet`).
- Text (`draw`) elements are drawn with the **real wording and font**. This is because text position and wording are what is being checked.
- The camera is shown as `from → to`. `prompt` moves only the picture inside the generated video box, and leaves text, shapes and imported files in place, as in the real composite. `digital` moves the whole scene.

## Flow for a video work
After brief step 7, decide `speech` (lines), `beats` (actions) and `scene` (scene) for each generated video element (`references/brief.md`; how to write a scene is in `references/scenes.md`). If even one of these three exists, the `preview` video of that work gets a **time strip** on top of the frame. The time strip is outside the frame, so it does not hide the check of text positions. An element and a work with none of the three have no strip and no voice.
1. Write the brief and `preview`. If there are lines, the machine's own voice reads each line (the element's `voice`: male or female) — `say` on macOS, Windows' built-in voices on Windows, `espeak-ng` on Linux. A line containing Hangul gets a Korean voice, and any other line an English one. A line the machine has no voice for is not an error: it is previewed silently, with its timing estimated from the text, and the output says so (`voice` and the `voice_estimated` warning, below). Tell the user once, do not retry the preview for it, and do not switch to another voice.
2. The time strip shows the whole time axis, the cut boundaries, the sound stretches of the lines, the action name tags and stretches, and the current time. Name tags whose stretches overlap go down to a lower row and the strip gets taller. While an element with a scene or lines is visible, a very small floor sound plays under it (for an element with `keepAudio: false`, the voice and the floor sound are left out too).
3. If a scene throws, it is `SCENE_FAILED`. Fix the scene file according to the element id and clip time in the message, and `preview` again. It is the same when a scene calls a word, line or action id that is not in `S`.
4. **The user fixes it in words** ("lift the cup later", "a bigger smile"). Depending on what was fixed, fix the matching things **together**.
   - Time: `at`, `offsetMs` and `durationMs` of `beats`, and the **`prompt` sentence** of that action. The sentence must have the new time or word too, for the video model to follow it. A `previewOnly` action has no sentence, so fix only `beats`.
   - Lines: `speech.lines[].text` and the same sentence in the element `prompt`, together. Fixing only one gives `BRIEF_INVALID`.
   - Shape (cup size, person color): the scene file.
5. `preview` again. Repeat until it is to the user's liking, then go to `references/estimate.md`. If you fix `brief.json` (including `speech` and `beats`) after approval, it is `APPROVAL_STALE`. The scene file does not go into the approval hash, so if you fix only the scene, the approval stays.

The code keeps the line times honest: an action tied to a word must have that word in the sentence, and a line sentence must be in `prompt` exactly. What the code cannot keep is whether `offsetMs`, `durationMs`, or a time based on `ms` or `lineEnd` matches the seconds expression in the sentence. When you fix something, Claude matches them directly.

**What `voice` says.** The `preview` output has a `voice` field: `null` when the preview spoke no line (an image work, or no element with lines), otherwise `{ engine, readLines, estimatedLines, missing, degraded }`.
- `engine` is `say` (macOS), `sapi` (Windows) or `espeak-ng` (Linux); `none` means the machine's engine program could not be started at all, so every line is estimated.
- `readLines` lines were read by a voice; `estimatedLines` were not (no sound, timing from the text).
- `missing[]` names each voice that could not be used, as `{ lang, kind, reason }` (`lang` is `ko` or `en`, `kind` is `male` or `female`). `degraded[]` names each voice replaced by another voice of the same language, as `{ lang, kind, used }`, so the user hears another gender than the brief asked for.
- `warnings` carries one `{ element, kind: "voice_estimated" }` for each element with an estimated line.

When `estimatedLines` is above 0 (or a `voice_estimated` warning is there), tell the user once, in a sentence like: "Line timing is estimated from the text; the preview has no voice sound for Korean lines." Name the languages from `missing[]` (and say the machine has no voice engine when `engine` is `none`). If `degraded[]` is not empty, say which lines were read by another voice (`used`). The time strip, the mouth and the action times still work on estimated lines, and the film keeps its room tone. To hear the lines, the user adds a voice (`references/setup.md`, "Preview voices and their terms"); the user does that, and the next `preview` picks it up.

**The voice's times differ from the real ones.** The first time you show a video, tell the user once — the line times differ (for example, in one work a Mac voice was one block of 0.5–3.1 seconds, while the real model was two blocks, 0.6–1.5 seconds and 2.1–3.2 seconds). So they should look at which word an action comes on, not at exactly which second. It is for getting a feel, so do not fit the times to the real ones. Delivery cannot be judged from the preview either: the Linux voice is robotic and its Korean is rudimentary.

## How to show it to the user
1. Claude first opens the frames (`frames`) directly. To see the whole shape video, make a contact sheet with `sheet <absolute path of preview.mp4> --every <ms>` and look at it.
2. To the user, summarise in words the cut order and lengths, what goes where, and the text wording and when it appears, and give the file paths. For a rough drawn video, also say which action comes on which word. Claude does not open the video for the user: the user opens it from the path.
3. If there are `warnings`, do not hide them; tell the user. Example: `title` is cut off → suggest enlarging the box or reducing `sizePx`.
4. Ask one question at a time, with a recommendation and the reason (the same as `references/brief.md`).

## What it checks / what it cannot check
| Checks | Cannot check |
|---|---|
| Cut order and lengths | Texture |
| Position, size and stacking order (`z`) of boxes | Lighting |
| Start and end of camera movement | Faces |
| Text wording, position, and when it appears and disappears | Real color feel |
| How each element is made (which element costs money) | How the generated elements will actually come out |
| Which word an action comes on, the action order and rough length | The real line times (they differ from the preview voice) |
| Whether the lines fit inside the clip | How well the model follows the actions, and model habits (it does not follow instructions in seconds well, and it sometimes breaks a line written as one block into two blocks when speaking it) |

What cannot be seen is the job of generation, and is included in the estimate. That is why, for a video, the keyframes are made first for the user to see (`references/review.md`). Make it clear to the user that their confirmation that "the shape and rough drawn video is fine" does not mean the faces, color feel and texture are fine too.

## Repeating fixes
1. When the user says where to fix, fix only `brief.json` (cut length, `rect`, `camera`, text, way of making). For the lines, actions and scenes of a rough drawn video, see step 4 of "Flow for a video work" above.
2. `preview` again. Brief validation runs first every time — if it fails, fix it as `error.details.issues` says.
3. When the layout and text are to the user's liking, go to `references/estimate.md`.
4. Each time you fix something, say in one line what changed.
5. If you fix the brief after approval, the hash changes and `generate` refuses with `APPROVAL_STALE` — go back to steps 3–4 (`estimate`, approval). But if you changed the layout (layout, components, cuts, size, and so on — what is drawn into the layout guide PNG), **run `preview` again first**, and then `estimate` and a new approval. The guide image sent to the generation model (`ref-<element>.png`) is a file `preview` wrote, so if you skip `preview`, `estimate` and `generate` notice that it differs from the picture redrawn with the current brief and refuse with `BRIEF_INVALID` (`run preview again`). When you estimate again, only the elements that are not finished go in as lines. A fix that does not change the input fingerprint of a generated element, such as the text wording, leaves nothing to generate again, so run only `make` again (`make` does not look at approval).
