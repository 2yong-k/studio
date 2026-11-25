// @ts-check
// Plain JS on purpose: an old Node must parse this file to reach the floor message, so keep to ES2020
// and `node:` imports (packages are only import()ed at run time).

// A release candidate, a nightly or a custom build (`25.0.0-rc.1`, `24.0.0+my_build`) is judged by its x.y.z:
// refusing one would also turn the guard off, so any suffix is let through.
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].+)?$/;

/**
 * True for the Node versions that strip types without a flag: 22.18+, 23.6+ or 24+.
 * @param {string} version like `process.versions.node` (no leading `v`)
 * @returns {boolean}
 */
export function nodeSupported(version) {
  const m = VERSION.exec(version);
  if (m === null) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major >= 24 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);
}

/**
 * @param {string} version
 * @returns {string | null} null when supported
 */
export function nodeProblem(version) {
  return nodeSupported(version) ? null : `Node 22.18 or newer is required (23.6 or newer on Node 23), got ${version}`;
}

/**
 * True for the Node versions whose fetch takes HTTP(S)_PROXY under NODE_USE_ENV_PROXY: 22.21+ or 24+ (never 23).
 * @param {string} version like `process.versions.node`
 * @returns {boolean}
 */
export function envProxySupported(version) {
  const m = VERSION.exec(version);
  if (m === null) return false;
  const major = Number(m[1]);
  return major >= 24 || (major === 22 && Number(m[2]) >= 21);
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];

/**
 * Claude Code's sandbox lets a command out only through the proxy named in HTTP(S)_PROXY, and fetch ignores those
 * unless NODE_USE_ENV_PROXY is set when Node starts; setting it later in the process does nothing.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} version
 * @returns {NodeJS.ProcessEnv | null} the environment for a second run with the proxy on, or null to go on here
 */
export function proxyRerunEnv(env, version) {
  // Already decided, by this launcher's own rerun, by the sandbox (it sets it on Windows) or by the user.
  if (env.NODE_USE_ENV_PROXY !== undefined) return null;
  const named = PROXY_VARS.map((k) => env[k] ?? '').filter((v) => v !== '');
  if (named.length === 0 || !envProxySupported(version)) return null;
  // Node stops at start on any value that is not an http or https URL (`proxy.corp:8080`, `socks5://…`), which curl
  // takes; such a value keeps the run as it was, without the proxy.
  if (!named.every(httpUrl)) return null;
  return { ...env, NODE_USE_ENV_PROXY: '1' };
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function httpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Where the packages come from: the plugin cache for an installed plugin, or the folder itself when it is loaded in place (--plugin-dir or a local marketplace).
export const REINSTALL =
  'reinstall the plugin or run claude plugin update studio@2yong-k; for a plugin folder Claude Code loads in place (--plugin-dir or a local marketplace; in a clone of 2yong-k/studio, its plugins/studio), run npm ci --ignore-scripts in that folder';

/**
 * Loading the package is not enough: `new Canvas` is what loads Skia.
 * @returns {Promise<string | null>} null when the drawing package works
 */
export async function loadCanvas() {
  try {
    const { Canvas } = await import('@napi-rs/canvas');
    new Canvas(1, 1);
    return null;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const first = message.split('\n')[0] ?? '';
    return `the drawing package @napi-rs/canvas cannot load on ${process.platform}-${process.arch}: ${first}; ${REINSTALL}`;
  }
}

/**
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function hasPackage(name) {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

// A --disable-warning flag would make a Node older than 20.11 exit before any check, so the filter lives here.
/** @returns {void} */
export function quietTypeStripping() {
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning') return;
    process.stderr.write(`(node:${process.pid}) ${warning.name}: ${warning.message}\n`);
  });
}
