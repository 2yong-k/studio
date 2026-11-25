# Estimate and approval — the last door before money goes out
Status: in use
Date: 2026-10-29

Generation moves only when there is an estimate the user has approved (hard rule 1). This document is how to make the estimate, show it, and get the approval and record it.

## Making the estimate
```bash
studio estimate <work>
```
It validates the brief, looks up the unit price of each generated element, and writes `estimate.json` (calling it again overwrites it). No money goes out (in live mode it only makes the price lookup calls). Fake mode uses recorded prices, so they may differ from the real amounts — tell the user they are practice values.

Main fields of the output:
| Field | Meaning |
|---|---|
| `estimate.lines[]` | One generated element = one line (attempt number 1). `element`, `model`, `unit`, `unitSize`, `unitPriceMicros`, `quantity`, `amountMicros`, `dependsOn` |
| `estimate.spendMicros` | The money already spent when you estimate again |
| `estimate.subtotalMicros` | `spendMicros` + the sum of the lines |
| `estimate.capMicros` | The work's cap = floor(subtotal × 1.2) |
| `removalSavings` | Per element, "the money saved if you drop it" (μUSD string). For a video line that uses a generated keyframe (`from`), it is the amount with that keyframe's line removed too, but only before that keyframe is finished (a finished keyframe has no line, so it is the video's own line amount); for a video line with an imported keyframe (`fromFile`) there is no keyframe line, so it is its own line amount |
| `usd` | `$` values for display (`spend`, `subtotal`, `cap`, `lines`, `removalSavings`). To the third decimal place, and anything under $0.001 is `<$0.001` |

Amounts (`…Micros`) are integer strings in micro-dollars. For the user, use the `usd` values.

**Stated prices.** For a model whose price API gives only a placeholder (`units`/$1) instead of a price (for now the GPT Image 2.5 family and Nano Banana 2.1), the price from the model page is written in `billing.stated` of the bundled `data/models.json`, together with the check date and the source, and used. A later re-check of the page is recorded in the studio folder (`<home>/price-checks.json`) with `price-check` (below). The estimate uses that record when its check date is the same day as the bundled check date or later, and the bundled price otherwise. The `priceSource` of that line is `stated-price <check date> <source>`. In live mode, if the check date in use is more than 30 days before the estimate date, or in the future, it stops with `PROVIDER_ERROR` (`details.field`: `stated.checkedAt`). Then read the model page at `details.source` again, record it with `price-check` as below, and estimate again. Fake mode skips this date check: it spends nothing, and a fake approval never carries over to live mode.

**Re-check for every work.** In live mode, before showing the estimate to the user, if a generated element uses a model that has `billing.stated` (now `gpt-25-flare`, `gpt-25-sunburst`, `banana-21`, `minimax-h3`, `heygen-video-1`, `wan-30`), read that model's `source` page again whatever the check date is, and record what it says. It spends nothing and makes no network call. Write the page price with the Write tool to `<home>/price-check-input.json`, then run:
```bash
studio price-check <model> --stated-file "<home>/price-check-input.json"
```
The file is the page price in the shape of that model's `billing.stated`, without `checkedAt` (the command records today's local date), plus a `model` field equal to `<model>`: `{ "model", "unit", "unitPriceUsd", "source" }` for a single price, or `{ "model", "unit", "bySize": [{ "w", "h", "unitPriceUsd" }, …], "source" }` with a line for every size, in the same form and `unit` as the bundled entry. Prices are decimal strings (`"0.06"`), and `source` is the page you read. A file without `model`, or with another model's id, gives `USAGE`. After a successful record the command removes the file, so write it again for each check (a refused check leaves it in place). Never put the JSON on the command line with `--stated`: a Windows shell can mangle its quotes.
- **The same price** as the one in use: it is recorded and the output has `changed: false`. Then estimate.
- **A different price**: it refuses with `PRICE_CHANGED` and records nothing. `details.before` is the price in use and `details.after` the page price. Show the user both and that the estimate will use the new one, and only after the user confirms it in the conversation, run the same command again with `--changed` (the output has `changed: true`). Never add `--changed` without that confirmation. Then estimate.
- `USAGE` with `details.issues` means the JSON does not fit the model's entry — fix it as the issues say. A different form (a single price in place of per-size prices, or the other way round) is a change to the model entry, not a price change, so it is refused; tell the user.
- `USAGE` with `details.checkedAt` later than `details.today` means the bundled price was checked on a date that has not yet begun where the user is (for about a day after an update). Until that date, live estimates with that model stop too (a check date in the future). Tell the user, and re-check on or after that date.

The 30-day check stays as a safety net for when you miss the re-check. Do not do this for a practice estimate in fake mode.

**Per-size prices and the larger value.** For a model whose API price represents only the lowest resolution (for now, the videos MiniMax H3, HeyGen Video 1 and Wan 3.0 — `minimax-h3`, `heygen-video-1`, `wan-30`), the price for each size (`w`, `h`) is written in `billing.stated.bySize`. Every size in `sizes[]` must have a line, and sizes that send the same parameters must have the same price. If the API unit matches, then after the check-date check (30 days, live mode) use the **larger** of the API price and the stated price for that size, and if they are equal, write it as API. The rule exists so the estimate never comes out smaller than the real charge. If the API gives a placeholder, use the stated price for that size. A single-price `stated` is for guarding against a placeholder, so if the API gives a price, use the API price. The `priceSource` of the line records the one that won.

## Showing it as an estimate table
Turn the output of `estimate` into the table below and show it to the user. The columns are element · model · unit · quantity · amount · **money saved if dropped**. Below is a fake-mode example (not real amounts).

| Element | Model | Unit | Quantity | Amount | Money saved if dropped |
|---|---|---|---|---|---|
| `c1-key` cut 1 keyframe | `gpt-25-flare` | 1M tokens | 1,877 | $0.056 | $0.056 |
| `c1-plate` cut 1 background and coffee | `happy-horse-11` | seconds | 5 | $0.700 | $0.756 (keyframe included) |
| **Subtotal** | | | | **$0.756** | |
| **Work cap** | | | | **$0.908** | |

- The displayed amounts are rounded to the third decimal place. The subtotal is computed as the exact sum in micro-dollars, and the cap is that subtotal × 1.2 rounded down, so adding up the numbers on screen can be off by about $0.001.
- "Money saved if dropped" is `removalSavings`. Dropping a video that uses a generated keyframe drops that keyframe too, so the sum equals the subtotal. For a video with an imported keyframe, only its own line drops.
- Text (`draw`), `capture` and `composite` elements do not appear in the estimate lines (they cost no money).
- If money has already been spent, `spendMicros` is included in the subtotal. When you estimate again, only the elements that are not finished go in as lines.

Add a sentence or two under the table: which element is the most expensive, and how much it would be if you dropped or cut it (a shorter length, fewer cuts).

## Margin and cap
- The **margin** is 20% of the subtotal. It shows in advance the money for trying again. It is what you spend when you partially fix a clear defect.
- The **cap** is the subtotal × 1.2 (rounded down). If this call is added and spend would go over the cap, `generate` refuses with `CAP_EXCEEDED`. To lift the cap, show a new estimate and get a new approval — do not work around it in code.
- If the amount to retry one element is larger than `cap − spend`, that element cannot be made again. In a work where the video line is most of the subtotal (the example above), the video cannot be made one more time on the margin alone. If the work is like that, say so in advance when you ask for approval.
- When spend reaches the approved subtotal (equal or over), `budget: "margin_in_use"` is added to the output. If equal, it finished as estimated, so the margin is intact, and tell the user that from now on the money for remaking comes out of the margin. If over, tell them how much of the margin was used.
- The wait time cap is 5 minutes for an image and 20 minutes for a video.
- The estimate is computed rounding up so that it is not lower than the real amount. Even so, the real spend is fixed after the call by `spend.jsonl`.

## Getting approval
1. Show the table above and ask like this. You may change the tone naturally, but the **amount, the cap and what goes out** must always be in it.

   > Here is the estimate. The subtotal is $0.756, and up to $0.908 including the margin for fixes. I will first make one keyframe ($0.056); once you have checked the picture, I will make the video ($0.700). If you approve this, please answer "approve". If there is anything to drop or cut, tell me.

2. When the user says something that is **a clear agreement to this estimate**, such as "approve", run `approve` then.
   ```bash
   studio approve <work>
   ```
   If it is vague, like "looks nice" or "hmm…", it does not count as approval; ask again. Do not carry general praise or agreement from an earlier step over as approval.
3. `approve` appends one approval line with the current brief and estimate hashes and the mode. If the estimate does not match the current brief (or mode), it is `APPROVAL_STALE` — call `estimate` again (`preview` first if you changed the composition). If there is no estimate, it is `USAGE` (`estimate` first).
4. Confirm the approved subtotal and cap to the user once more, briefly, with `approved`, `cap` and `usd` in the output.
5. If an adjustment request comes, fix the brief and start again from `estimate`. If the adjustment changes the composition (layout, components, cuts, size), run `preview` again first. The earlier estimate is not an approval.

The approval is tied to the brief hash and the estimate file hash. If the brief changes after approval, or you call `estimate` again (it writes a new estimate file even when the brief is the same), `generate` refuses with `APPROVAL_STALE` (`details.field`: `briefHash`, `estimateHash`, `mode`), and you go back to steps 3–4 for a new estimate and approval. So after approval, call `estimate` again only when you change the brief. If the fix changed the composition, run `preview` again before that — the guide image sent to the generation model is a file `preview` wrote, and if you skip it, `estimate` notices the old picture and refuses with `BRIEF_INVALID` (`run preview again`).

## Keyframe confirmation is a different approval
The user looks at the video's keyframes once more, separately from the estimate approval (`approve <work> --keyframes`). Approving the estimate does not mean it is fine to pay for the video as well. The method is in `references/review.md`.
