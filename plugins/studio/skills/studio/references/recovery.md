# Generation recovery runbook
Status: in use
Date: 2026-10-29

This is the procedure for clearing attempts when `generate` stops midway, and the monthly check. There is one principle — **never send an attempt that was sent or is unconfirmed again** (hard rule 2). Clear them only with `status` and `resolve`. All commands are `studio …` (SKILL.md).

An attempt id is `<work>/<element>/<number>` (for example `2026-10-30-pilot/c1-key/1`), and the states are `submitting` (not sent) → `sent` (sent, unconfirmed, has a request id) → `settled` (confirmed). If an element has an unconfirmed attempt, a new `generate` is refused with `ATTEMPT_UNRESOLVED`.

## 1. Stuck in `submitting`
**Symptom.** `results[]` of `generate` has `state: "submitting"`, `error: "ATTEMPT_UNRESOLVED"` and a `cause`. Or the attempt shows up in `submitting[]` of `status`. The submission ended with an exception, or the process died midway, so it is not known whether the request reached fal. There is no request id, so `status` cannot look it up.

**Procedure.**
1. Do not `generate` again. With `status <work>`, check the `attempt` and `at` (time) in `submitting[]`. `at` is UTC (the `Z` at the end), so convert it to the user's local time when you tell them.
2. Read the `cause` and tell the user. A key error (`KEY_MISSING`) happens before the attempt line is written, so you will not see it here. Even if the submission ended with an exception such as a network error, the `cause` alone cannot tell whether the request reached fal — do not skip the console check in step 3.
3. **The user checks in the fal console** — whether a request made by a call to this model exists around that time (`at`). Claude does not look at the key or look it up through the API (hard rule 4).
4. Record according to the result the user gives. These commands send nothing and only record the user's answer.
   - The request does **not exist** → `resolve <work> <attempt> --not-sent`. The attempt closes as `settled`·`not_sent` ($0). That element can be `generate`d again.
   - The request **exists** → `resolve <work> <attempt> --request-id <the request id fal showed>`. A `sent` line is written with that id, and `status <work>` takes over, downloads the result and clears it.
   - If the request id the console showed (or the id left in the error `cause`) is not in an accepted format (1–128 characters of letters, digits, `_` and `-`), `resolve --request-id` refuses it with `USAGE`. `status` cannot fetch a result with that id. After the user has checked that request in the fal console, close it with `resolve <work> <attempt> --failed`. It sends nothing and closes as `settled`·`provider_failed`, and the money stays in the spend at the estimated amount.
5. Look at `spend` and `usd` in the output to see whether the spend changed correctly (for `not_sent`, that attempt's amount comes off).

If the user cannot confirm with certainty in the console, use neither `--not-sent` nor `--request-id`. Leave the spend counted conservatively at the estimated amount and tell the user the situation. If the user checks the console and says there is no usable request, propose `resolve <work> <attempt> --failed`. It sends nothing and closes the attempt as `settled`·`provider_failed`. The money stays in the spend at the estimated amount (safe on the side of the cap). After it is closed, `generate` with no element given does not send that element and reports `LAST_ATTEMPT_FAILED`. To send the same input again, tell the user and use `generate <work> --element <element> --reason "…"`, or fix the brief and get a new estimate and approval. A new attempt is also sent only within the cap.

## 2. `sent` does not finish for a long time
**Symptom.** `results[]` has `error: "WAIT_TIMEOUT"` (wait cap: 5 minutes for an image, 20 minutes for a video), `PROVIDER_ERROR` or `DOWNLOAD_REJECTED`, and `state` is `sent`.

**How to run.** Run `generate` and `status` with the Bash tool's `run_in_background` and wait for the notification that it finished. A live-mode video waits up to 20 minutes, and a call run directly in the foreground cannot run that long. If the run was cut off or the output was lost, call `status` first and do not call `generate` again.

**Procedure.**
1. Call `status <work>`. For each `sent` attempt it looks up the request id and clears it all the way (download · check · record). It does not send again.
2. If it is not finished yet, call `status` again a little later. A video can take a few more minutes.
3. If it fails at the result stage, it stays `sent` and can be retried with `status`. If it still keeps giving `PROVIDER_ERROR`, tell the user the `results[].cause` and have them look at that request's state in the fal console. fal's queue result records do not stay long after completion (at the last check, an hour, and only minutes for a large result) — do not leave it, and call `status` quickly. If `status` keeps failing because the result record is already gone or the id written with `--request-id` is wrong, close it with `resolve <work> <attempt> --failed` after the user has checked the fal console. It sends nothing and closes as `settled`·`provider_failed`, and the money stays in the spend at the estimated amount. After that, `generate` with no element given skips that element with `LAST_ATTEMPT_FAILED`. To send the same input again, tell the user and use `generate <work> --element <element> --reason "…"` within the cap, or fix the brief and get a new estimate and approval.
4. `DOWNLOAD_REJECTED` means the download stage is blocked (a disallowed address, over the size cap, and so on). The attempt stays `sent` and the money is counted as already gone. Call `status` again, and if it stays blocked, tell the user the `results[].cause`. If it is blocked for the same reason every time you call `status`, calling again will not clear it. After the user has checked that request in the fal console, close it with `resolve <work> <attempt> --failed`. It sends nothing and closes as `settled`·`provider_failed`, and the money stays in the spend at the estimated amount.
5. If the downloaded file does not pass the check (format · size · length), it is not an error; the attempt closes as `settled`·`outcome: "rejected"`. The money went out, so the spend stays. Ask the user whether to go to a partial fix (`references/review.md`).
6. If the supplier refuses the input (HTTP 422, in the shape written in the docs) and no result can be received, the attempt closes by itself as `settled`·`outcome: "refused"`. No console check or `resolve` is needed. The money is counted at the estimated amount, like `provider_failed`. Tell the user the `results[].reason`, change the input, and get a new estimate and approval (see "When the model refuses" in `references/prompting.md`). The same input cannot be sent again even with `--element` (`INPUT_REFUSED`). A 422 that is not in the shape written in the docs, or that points at the request itself, is not closed and stays `sent`, so treat it like step 3 above.

## 3. A leftover `.lock`
**Symptom.** A `LOCKED` error and `details.pid`. There is a `.lock` file in the work folder — `estimate`, `generate`, `status` and `resolve` create it so that only one runs at a time.

**Procedure.**
1. Check whether that process is still running with `details.pid` (or the number inside `.lock` if there is none): on Windows run `Get-Process -Id <pid>` in PowerShell (an error means the process is gone) or look for the pid in Task Manager; on macOS and Linux look for it with `ps`.
2. If it is running, another command is still working. Wait for it to finish.
3. If it is not, the lock was left by an abnormal exit. **The user deletes it** (with a file manager, or `rm` in a Unix shell or `Remove-Item` in PowerShell, on `<work folder>/.lock`). The reason it is not deleted automatically is to prevent two runs spending money at the same time because a lock was deleted wrongly. Claude does not delete it.
4. After deleting it, call `status <work>` first to check whether an attempt stopped midway (sections 1 and 2).

`price-check` locks the studio folder instead (`<home>/.lock`). A leftover one gives `LOCKED` with `details.pid` the same way, and the same rule holds: only after checking that the pid is gone does the user delete `<home>/.lock`. Then run `price-check` again.

## 4. Matching fal charges against the spend record (once a month)
**Purpose.** Check that the spend record (`spend.jsonl`) does not drift from the amount fal actually charged.

**Procedure.**
1. For each live-mode work (`<home>/works/`) of the month being checked, call `status <work>`. `usd.spend` in the output is that work's spend total (an unconfirmed attempt is a conservative value counted at the estimated amount). If unconfirmed attempts remain, clear them first with sections 1 and 2.
2. Add up the spend per work.
3. The user tells you the total usage (charge) for that month in the fal console.
4. Compare.
   - Spend record ≥ fal charge: the normal range. The record counts failures such as an input refusal (422) as charged (the fal queue does not tell charged failures from uncharged ones), counts the requested size even when the received file is smaller than requested, and counts an unconfirmed attempt at the estimated amount.
   - fal charge > spend record: it means there are calls not in the record. Before looking for the cause, stop new generation and tell the user the month, both amounts and the difference — it may be a bug in studio for the plugin's maintainer.
5. The user keeps the result (the month, both amounts) in their own records.
6. At the same time, look at the prepaid balance and the credit expiry date — fal's terms say credits expire 365 days after the purchase date.

## 5. Plugin updates in the middle of a work
The layout guide PNG is drawn with the plugin's drawing packages, and the bytes of that PNG go into the input fingerprint of a generated element. An update that changes those packages can change the PNG bytes even for the same brief — then the input fingerprint changes and **an attempt that already passed is no longer "finished", and the approval no longer matches.** The money is spent again.

- Update the plugin **only between works** (`references/setup.md`, "Updates"). Do not update while a work is generating after estimate approval or has not yet been `finish`ed.
- After an update, if `estimate` or `generate` on an older work stops with `BRIEF_INVALID` (`run preview again`) or `APPROVAL_STALE`, start again from `preview` → `estimate` and get the user's approval anew, and tell the user that elements already made may be counted as unfinished. A new work is not affected.

## 6. A broken page-price record
**Symptom.** `CONFIG_INVALID` whose message says `<home>/price-checks.json is not a valid price-check record` (or that a check in it names no model in the bundled list, or a model priced by the pricing API). The file holds the user's page-price checks (`references/estimate.md`). Every command that reads a work's brief stops on it — `preview`, `estimate`, `generate`, `approve`, `make`, `sheet`, `finish`, `smoke` and also `status`, so a `sent` attempt cannot be cleared until it is fixed — and so does `price-check`. `resolve` does not read prices, so it still records the user's answer.

**Procedure.** Do not edit the file. With the user's go-ahead, move it aside — rename it (for example to `price-checks.broken.json`); never delete it. The bundled prices then apply again, and the records are made anew with `price-check` at the next live estimate. If the message says a check "no longer fits the bundled entry", the file itself is fine: re-check that model's page and record it with `price-check` instead. But if that `price-check` fails because another model's record no longer fits either (each check reads every other record), move the file aside as above.
