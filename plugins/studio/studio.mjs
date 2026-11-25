// @ts-check
// Plain JS on purpose: an old Node must parse this file to reach the floor message, so keep to ES2020
// (no top-level await) and `node:` imports.
import { spawnSync } from 'node:child_process';
import { loadCanvas, nodeProblem, proxyRerunEnv, quietTypeStripping } from './src/plugin/preflight.mjs';

/**
 * The same command in a Node that sends fetch through the proxy; this process only waits and passes on its exit code.
 * Node warns that the proxy agent is experimental on every start, which would fill stderr of every command.
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function rerun(env) {
  const args = ['--disable-warning=UNDICI-EHPA', ...process.execArgv, ...process.argv.slice(1)];
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (r.error !== undefined) {
    process.stderr.write(`studio: ${r.error.message}\n`);
    return 2;
  }
  if (r.status === null) {
    process.stderr.write(`studio: the command stopped on ${r.signal ?? 'an unknown signal'}\n`);
    return 2;
  }
  return r.status;
}

async function start() {
  const tooOld = nodeProblem(process.versions.node);
  const proxied = tooOld === null ? proxyRerunEnv(process.env, process.versions.node) : null;
  if (proxied !== null) {
    process.exitCode = rerun(proxied);
    return;
  }
  const problem = tooOld ?? (await loadCanvas());
  if (problem !== null) {
    process.stderr.write(`studio: ${problem}\n`);
    process.exitCode = 2;
    return;
  }
  quietTypeStripping();
  const { main } = await import('./src/cli.ts');
  process.exitCode = await main(process.argv.slice(2), process.env);
}

// A failure after the preflight (a package that will not import, a rejection) still ends in one line, never a stack.
start().catch((/** @type {unknown} */ error) => {
  const text = error instanceof Error ? error.message : String(error);
  const line = text.split('\n').find((l) => l.trim() !== '');
  // With no text the line names the error's type, or says so, so it never ends at `studio: `.
  process.stderr.write(`studio: ${line ?? (error instanceof Error ? error.name : 'unknown error')}\n`);
  process.exitCode = 2;
});
