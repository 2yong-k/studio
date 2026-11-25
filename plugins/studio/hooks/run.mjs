// @ts-check
// Plain JS on purpose: an old Node must parse this file to reach its check, so keep to ES2020 (no top-level await)
// and `node:` imports. Usage: node run.mjs guard|session-start.
// Claude Code shows a hook that fails as an error notice on every call it hooks, so when Node or a package is not
// usable the guard lets the call through without a word (exit 0, nothing printed), and session-start prints one line
// that says what to fix and exits 1.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasPackage,
  loadCanvas,
  nodeProblem,
  nodeSupported,
  quietTypeStripping,
  REINSTALL,
} from '../src/plugin/preflight.mjs';

/** @param {string} text */
function fail(text) {
  process.stderr.write(`studio: ${text}\n`);
  process.exitCode = 1;
}

// Claude Code loads a plugin without its node_modules when the dependency install failed or timed out.
/** @returns {Promise<string | null>} */
async function zodProblem() {
  if (await hasPackage('zod')) return null;
  const modules = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
  return `packages missing from ${modules}: zod; ${REINSTALL}`;
}

async function guard() {
  if (!nodeSupported(process.versions.node) || !(await hasPackage('zod'))) return;
  quietTypeStripping();
  await (await import('../src/plugin/guard.ts')).run();
}

// session-start reaches the drawing package through the config module's imports, and a package that is there but
// cannot load would end in a stack trace, so the package is loaded once first.
async function sessionStart() {
  const problem = nodeProblem(process.versions.node) ?? (await loadCanvas()) ?? (await zodProblem());
  if (problem !== null) return fail(problem);
  quietTypeStripping();
  await (await import('../src/plugin/session-start.ts')).run();
}

const hook = process.argv[2];
if (hook === 'guard') guard();
else if (hook === 'session-start') {
  // Any failure after the preflight (a package that will not import, a rejection) still ends in the one line.
  sessionStart().catch((/** @type {unknown} */ error) => {
    const text = error instanceof Error ? error.message : String(error);
    const line = text.split('\n').find((l) => l.trim() !== '');
    // With no text the line names the error's type, or says so, so it never ends at `studio: `.
    fail(line ?? (error instanceof Error ? error.name : 'unknown error'));
  });
} else fail(`unknown hook ${hook ?? ''}`);
