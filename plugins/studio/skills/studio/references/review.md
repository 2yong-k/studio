# Review, keyframe confirmation and finishing
Status: in use
Date: 2026-10-29

The generated originals were bought with money and cannot be obtained again with the same request. So Claude first checks against the brief (review), and filters the results before the user, then shows them. When the judgement is ambiguous, stop and the user decides.

## 1. Keyframe confirmation (5b) — a video cannot be made without this
The keyframe of a video generation element is looked at once by the user, whatever the review result. It is where the face, color feel and texture that the shape video could not confirm first appear, and because a video costs many times more than an image.

1. When `generate <work>` finishes and the output has `next: "keyframe_review"`, it means the keyframes were made. Check the attempts with `outcome: "accepted"` in `results[]`, and if there is a blocked attempt (`error`), clear it first (`status`).
2. Open the keyframe file directly. The path is `<absolute path of the work folder>/<results[].file>` (for example `…/raw/c1-key/1.png`).
3. **Claude reviews first** (the checklist in section 3 below). If there is a clear defect, fix it partially before showing it to the user (section 4).
4. If there is no defect, make a contact sheet and show it to the user.
   ```bash
   studio sheet <absolute path of the keyframe original>
   ```
   Tell them the path in `sheets[]` of the output (`review/sheet-….jpg`), and summarise in words whether the face, color feel and texture match what was intended in the shape video.
5. When the user **confirms in the conversation**, run this.
   ```bash
   studio approve <work> --keyframes
   ```
   One confirmation line is recorded for the passed keyframe attempts that match the current input fingerprint. If there is no passed keyframe, it is `USAGE`.
   This command confirms **all** passed keyframes **at once**, and the next `generate` spends the money for those videos. Before running it, write out and show the keyframes to be confirmed one by one, and run it only after the user has confirmed each one. If there is a keyframe the user rejected, remake it first (section 4).
6. Now call `generate <work>` again to make the videos. Before confirmation, it skips the videos, so `results` is empty and it ends with `next: "keyframe_review"` (not an error). Called with `--element <video id>`, it is refused with `KEYFRAME_NOT_CONFIRMED`. If you remake a keyframe, the video that uses it becomes unfinished and needs confirmation again.

An image work has no such step.

## 2. Making the candidate and the contact sheet (step 6)
```bash
studio make <work>
```
It makes `build/candidate.png` (image) or `build/candidate.mp4` (video) by drawing + compositing. Generated elements use the last passed attempt by default. Look at `file`, `raws` and `warnings` in the output. `make` does not look at approval and costs no money, so you may redo it any number of times. If there is no passed attempt with a matching fingerprint, it is `RAW_STALE`, and to use an old attempt, give `--use <element>=<number>` (the number is the digit at the end of the attempt id, for example `hero=2`).

Contact sheet for review:
```bash
studio sheet <absolute path of build/candidate.mp4 or candidate.png> [--every <ms>]
```
- `sheet` takes **absolute paths only** (a relative path is `USAGE`). The `file` that `make` returned is an absolute path, so use it as it is.
- For a video, it writes frames at a fixed interval (default 1000ms) to `review/sheet-<name>-N.jpg`. For `build/candidate.mp4` and `final/` files, it also marks the cut boundaries (`marksMs`) (the original clips do not have them). One video goes up to 240 cells, so giving `--every` too small is `USAGE`. Image files are gathered into one sheet (`review/sheet-images-N.jpg`) (at most 24 cells per sheet).
- You can give several files of the same work at once. If two video files have the same file name (two `1.mp4`, for example), it is refused, so call them one at a time.
- Read the `review/` files to look at them, and tell the user the paths.

## 3. Review checklist
Check the result against the brief (`brief.json`) one by one. Judge by looking at the sheet or frames with your eyes.
- [ ] **Text**: the wording does not differ from the brief by a single character. It is not broken or cut off. (Text is drawn with `draw`, so also look at `warnings` in the `make` output — `cut_off`, `overlap`, `too_small`.)
- [ ] **Count and position**: the number and places of elements match `layout` and `parts`.
- [ ] **People**: the same person carries through. Faces and hands are not distorted.
- [ ] **Brand colors and logo**: the brand colors have not drifted.
- [ ] **Feel**: it matches `mood`.
- [ ] For a **video**: any place where it changes abruptly at a cut boundary, whether the motion matches the `prompt`, and whether the length matches the cut length (within ±250ms). If a clip or a video capture is shorter than the stretch where it is visible, it stays stopped on the last frame until the end of the stretch, so if the end of a cut looks frozen, first look at the length of that file.
- [ ] **Caption times**: when putting captions in time with speech, match the times with `segments[]` (`startMs`, `endMs`) from `studio speech <absolute path of the video or sound file>`. It goes by volume, not speech recognition, so loud background sound widens the stretches; if a stretch comes out wider than the speech, measure again with a file that has no background sound. `segments[]` counts from the start of the measured file, while `enterMs` and `exitMs` of a box count from the start of the cut — if you measured `candidate.mp4`, subtract that cut's start time, and if you measured the original generated clip, add that clip box's `enterMs`.
- [ ] **Prohibitions**: a real person resembles only someone whose consent is confirmed. It does not resemble another party's brand. It is not a false scene that looks like fact (hard rule 6).

## 4. The boundary between a clear defect and an ambiguous one
**Clear defects** — for the following, if within the margin, remake only that element without asking the user.
- Broken text
- The person changed
- Count or position differs from the brief
- Text cut off
- Brand color drift
- Hand or face distortion

**Ambiguous ones** — if it is outside this list, or even if it is on the list your confidence in the judgement is low, **stop.** Differences of feel or composition where taste divides, parts the brief did not decide, and anything where you wonder "is this a defect?" belong here. Do not fix it automatically.

**A case that goes over the margin** also stops. Before the remaking call becomes `CAP_EXCEEDED`, work it out first with the cap calculation under "Margin and cap" in `references/estimate.md` (is `cap − spend` ≥ this element's amount?).

### Partial fix
```bash
studio generate <work> --element <element id> --reason "<one-line defect>"
```
- It remakes only that one element as a new attempt. `--reason` stays in the spend record — write specifically which defect it is for (for example `the fingers look like six`). `--reason` is used only together with `--element`, and an empty string is refused.
- **If you change the prompt, model, size or reference files, the brief hash changes and it becomes `APPROVAL_STALE`** (a new estimate and a new approval are needed. Changing the size changes the layout, so run `preview` again first). A partial fix within the margin is drawing a new attempt with the same input. If the defect is one that can be solved only by changing the prompt, treat it as an ambiguous case and ask the user.
- If the supplier refused the last attempt made with the current input (`outcome: "refused"`), `--element` is blocked with `INPUT_REFUSED`. The same input will be refused again and only the money goes out, so the input must be changed (see "When the model refuses" in `references/prompting.md`).
- After an attempt closed with `resolve --failed` or ended as `rejected` or `provider_failed`, `generate` with no element given skips that element with `LAST_ATTEMPT_FAILED`. To send the same input again, tell the user and write the element and the reason with this command. It is fine as long as the last attempt is not `refused` (a failure at the status step, an output check rejection, or closed with `resolve --failed`). If `content_policy_violation` shows in `reason` or `cause`, do not send the same input again; change the input.
- If the new attempt passes, `make` uses it. If the earlier attempt was better, `make --use <element>=<number>`.
- If you remake a keyframe, the video that uses it becomes unfinished and needs keyframe confirmation again.
- If `error` in the result is `ATTEMPT_UNRESOLVED`, `WAIT_TIMEOUT` or the like, do not call again. Clear it with `status` (hard rule 2, `references/recovery.md`).

## 5. The form for showing the user when it is ambiguous
Do it in conversation, without making a separate screen.
1. Say in one line what is ambiguous ("the shadow under the title is darker than intended, and I cannot judge whether it is a defect or a matter of taste").
2. Show a comparison image. Give the originals of the attempts to `sheet` at once.
   ```bash
   studio sheet <absolute path of raw/…/1.png> <absolute path of raw/…/2.png>
   ```
   (Images gather into one sheet.) For a video, show the sheet of the candidate files and write what differs for each attempt.
3. Reduce the choices to two or three and attach a recommendation and the reason. Write the **money** of each choice (the money spent so far in `usd`, the remaining cap).
4. Move only after receiving the user's decision. If more money is needed, go to a new estimate and approval.

## 6. Finishing (step 7)
Run only **after the user has approved publishing**.
```bash
studio finish <work>
```
- It copies the candidate (`build/candidate.png|mp4`) to `final/<work>.png|mp4`. If the same name exists, it adds `-v2`, `-v3` and does not overwrite. If there is no candidate, it is `NOT_FOUND` (`make` first).
- Tell the user the `file` in the output (the absolute path of the finished file) and `spend`, `approved` and `cap` (`usd`). Say in one line how much was spent against the estimate. If the spend is greater than the approved amount, also say how much of the margin was used (`margin_in_use` is attached even when the spend equals the approved amount).
- Do not delete the work folder. If there is a usable result (a hero sheet, a style sentence, a brand kit), ask the user whether to keep it as an asset ("Making assets" in `SKILL.md`).
- **Leave prompt lessons for every work.** After finishing, look back at what came out as the prompt said and what did not in this work, and if there is a lesson for the next image or video prompt, add it, one line at a time, to the section for that model in `<home>/lessons.md` in the studio folder (what you wrote and what came out · work folder and attempt · date). Create the file, with a section per model, if it does not exist yet. If it is the same result as an existing line in that file, only add the evidence, and if it contradicts, fix that line. If it confirms or contradicts a line of `references/prompting.md`, write that in `lessons.md` too — never edit the plugin's files, since every update replaces them. If there is no lesson, tell the user so in one line.
