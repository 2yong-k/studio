# Scenes — short code that draws a rough drawn video
Status: in use
Date: 2026-11-11

This is the file that draws the action of a generated video element by hand so that you can see it in `preview` with no money. Claude writes one for each work. The meaning of times and actions is in the brief (`speech` and `beats`, `references/brief.md`), and a scene holds only "how that action is drawn". Most of what the user fixes changes only the brief. The flow is in `references/preview.md`.

## Directing principles
1. **Make only one or two features resemble.** Draw only what makes it recognisable, such as grey hair and a black zip-up. A photo-like face is the video model's job, and it is the keyframe that confirms the face.
2. **Tie actions to words.** Hang them on a line word with `beats[].at.word` in the brief, and write that word in the `prompt` sentence too. The model followed "as he says 'this coffee'" better than seconds ("at about 1.5 seconds"). An action written only in seconds is not caught by the machine even when it drifts from the prompt.
3. **Do not draw production marks inside the frame.** Name tags, times and guide lines are shown by the time strip outside the frame. Captions are drawn not by the scene but by a `draw` element of the brief (the same place and font as the real composite).
4. **Do not leave a stretch standing still for more than 3 seconds.** Even with no speech, small movements such as blinking (`blink`), hand shake (`handheld`) and steam must keep going for it to read as video.

## File format
- It is an `.mjs` file inside the work folder, and the `scene` of a brief element points at it (for example `"scene": "scenes/take-plate.mjs"`). Under `assets/` is refused (`BRIEF_INVALID`, `elements.N.scene`). A missing file, or one outside the work folder, is also `BRIEF_INVALID`.
- The shape is only the one below. If `draw` is not a function, it is `SCENE_FAILED`.
```js
export default {
  draw(g, t, S, kit) {
    // draw the look at time t (ms) onto g
  },
};
```
- **Do not use `import` or `require`.** Receive what you need as `S`, `kit` and `g`. The check is a single regular expression on the file text, so `require(` or `import(` inside a comment or string, or an `import` at the start of a line, is caught too (`SCENE_FAILED`) — do not write those words even in comments. It is not a sandbox. A scene is a file Claude writes for the user, so it is trusted and run. Run a scene file someone else gave you only after reading it.
- `draw` is called from scratch for every frame. **Everything is a function of `t`.** Do not remember the previous frame and do not use `Math.random()` (for shake, `kit.hash`).
- `g` is a 2D canvas in the coordinate system of that element's box (top left 0,0, size `S.box`, design pixels) (it is the context of `@napi-rs/canvas`, not a browser). Anything outside the box is cut. A `prompt` camera is applied over the scene and a `digital` camera is applied to the whole cut.
- `t` is clip time (ms, fractions allowed). The clip starts at the box's `enterMs` and is called only while the box is visible. The first frame PNG of `frames` is drawn at `t = 0`.
- If the scene or `S` throws, `preview` stops with `SCENE_FAILED`. The message has the element id and the clip time (`failed at 1200 ms`). Calling a word, line or action id that does not exist on `S` is the same.
- The size target is 7KB or less. If it is over, the scene has grown, so shrink it with `kit` or take some drawing out.

## `S` — the timetable of this element
| Call | What it returns |
|---|---|
| `S.durationMs` · `S.box` | The element's `durationMs` · the box size `{ w, h }` |
| `S.parts` · `S.part(label)` | The box's `parts` moved into box coordinates `[{ label, rect }]` · the `rect` found by name tag (an error if absent) |
| `S.word(word)` | The start time (ms) of the first word in the lines that contains that word. A word is a space-separated unit, with punctuation removed |
| `S.line(i)` | `{ startMs, endMs }`: the stretch where the i-th line's sound plays |
| `S.beat(id)` | `{ startMs, endMs }`: the action's stretch. `previewOnly` can be called too. If there is no `durationMs`, `endMs === startMs` (an instant) |
| `S.mouth(t)` | 0..1: the loudness of the line sound at that time. The larger one if lines overlap. Hand it to the mouth |

Times are based on the preview voice (a line with no voice has estimated times). They differ from the line times in the real video (`references/preview.md`).

## `kit` — drawing tools
All coordinates are design pixels of `g`. Colors are CSS colors, and only `person` takes `#rrggbb`.
| Call | What it does |
|---|---|
| `P(t, t0, d, easing?)` | Progress 0..1. Starts at `t0` and takes `d` ms. If `d <= 0`, a step. Default `ease.io` |
| `ease.lin` · `io` · `out3` · `back` | Curves to pass as the fourth argument of `P`. `back` overshoots and comes back |
| `lerp(a, b, k)` · `clamp(x)` · `hash(i, seed)` | Interpolation · clamp to 0..1 · a 0..1 value with a fixed seed |
| `sketch(g, pts, { closed, fill, stroke, w, seed, jit })` | A line wobbled like a hand drawing. The wobble is fixed per point by the seed, so it is the same in every frame. `closed` defaults to true, `w` 5, `jit` 3, `seed` 1. `stroke` defaults to a dark ink color, and with `null` no line is drawn. If you leave out `fill`, nothing is filled |
| `dense(pts, step?)` | Puts points about `step` px apart (default 30, a number greater than 0) along each side of a closed shape, starts at the middle of the first side and ends at the point just before it (`sketch` closes it and returns to the middle). Passed to `sketch`, every corner is rounded the same, only about `step / 2`. Use it on a large shape with three or more sharp corners (a desk, a laptop, a window) |
| `ellipsePts(cx, cy, rx, ry, n?, a0?, a1?)` | `n + 1` points of an ellipse (or arc) (`n` defaults to 28). Angles are in radians and default to `0`..`2π` (0 is to the right, clockwise on screen). Pass them to `sketch` |
| `limb(g, from, joint, to, { w, fill, stroke?, seed? })` | A two-segment arm or leg. Thickness `w` |
| `blink(t, [time…], durMs?)` | Eye closure 0..1. Blink times are scene constants (not actions). `durMs` defaults to 140 |
| `handheld(g, t, S.box, amount?)` | Phone hand shake. Apply it **once, at the very start**. `amount` defaults to 1 |
| `background(g, key, S.box, (bg) => …, blurPx?)` | Draws once, keeps it blurred, and reuses it every frame (shallow focus). The callback draws in box coordinates and paints 100px more on every side to allow for the hand shake. `blurPx` defaults to 7 |
| `person(g, { x, y, scale }, look, pose)` | A front-facing upper body. `look`: `{ skin, hair, hairLength: 'short'\|'long', top, jacket }` — use all the keys (`jacket: null` if there is no jacket; leaving out a key throws). `pose`: `{ blink, mouth, smile, tilt }` — the first three are 0..1, and `tilt` is in **radians**. `x, y` is the center of the face. At `scale` 1 the upper body is 1120px wide (down to 1200px below the face), which is wider than a 1080 box — start around 0.5 |
| `cup(g, { x, y, scale }, t, { steam? }?)` | A white cup with rising steam. The scene draws the hand over it. `x, y` is the center of the body, and at `scale` 1 the body is 210×150px, the handle reaches +146px to the right, and the steam rises about 270px upward |

The scene draws arms and what is held in the hand with `limb`, `sketch` and `ellipsePts`. When you move and enlarge a cup, draw the `cup` and the hand together inside `g.save(); g.translate(…); g.scale(…)`.

## Pitfalls — all of them confirmed
- If a color of `person` is not `#rrggbb`, it throws (`rgb()` and named colors are not allowed). `pose.tilt` is in radians, not degrees (0.05 is about 3 degrees).
- The torso ends in a square hem at `1200 × scale` below the center of the face. If it ends inside the screen it looks like a lump, so lower the hem below the box or hide it with an arm or a prop.
- On a closed shape, `sketch` keeps only the first and last points sharp, and joins the other vertices round, from the middle of the side on one side to the middle of the side on the other. If you pass a large four-point rectangle (a laptop lid, a desk) as it is, only one side swells like a "D". If two vertices should be sharp, put those two at the start and the end (the hem of the `person` torso), and if three or more, pass it through `dense`. If all should be round, start at the middle point of one side that will be hidden and end at the same point (the long hair of `person`). A small rectangle (a book spine) shows less even if used as it is.
- The end of a `limb` is cut flat. Put the end off screen or behind another drawing. If you draw the upper arm before the person and put it behind the jacket, no background gap appears between the shoulder and the arm.
- `background` caches in the process by `key + box size + blurPx`. Each scene uses its own `key`. If they are the same, another scene draws someone else's background.
- In one process the same scene file is read only once (the Node module cache). `studio preview` is a new process every time, so a fixed scene is reflected right away, but if you fix it and call again inside one script or test, the old code runs.

## Example
A finished scene for a selfie clip came to about 5KB with `kit`. It used all of these: a blurred cafe background (`background`), a grey-haired person in a black zip-up (`person`), a selfie arm and a hand holding a cup (`limb`, `cup`, `S.beat('lift')`, `S.beat('lower')`), blinking, a smile and a head tilt (`S.beat('smile')`), and hand shake. A brief piece of the same kind is the `take-plate` example in `references/brief.md`. When a new work needs a scene like an earlier one of the user's, copy that work's scene file into the new work folder and change only the background, colors and action ids (give the background `key` a new name).
