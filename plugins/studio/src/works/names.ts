// An id becomes a file or folder name on every OS the work may move to, and goes onto Claude's command lines, so one
// rule holds everywhere. A non-NFC id is refused, not normalised, so the id in the brief stays the id in every file
// name and record.
// biome-ignore lint/suspicious/noControlCharactersInRegex: Windows refuses U+0000-U+001F in file names.
const WINDOWS_REFUSED = /[<>:"/\\|?*\u0000-\u001f]/;
const SHELL = /[$`';&()\s]/;
const DEVICE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;
const MAX_UNITS = 64;

// Windows reserves a device name whatever extension follows it: `con.x` opens the console.
const stem = (id: string): string => id.split('.', 1)[0] ?? id;

// In order; the first rule an id breaks gives the reason.
const RULES: readonly (readonly [(id: string) => boolean, string])[] = [
  [(id) => id === '', 'is empty'],
  [(id) => id === '.' || id === '..', 'is . or ..'],
  [(id) => WINDOWS_REFUSED.test(id), 'has a character Windows refuses in file names'],
  [(id) => SHELL.test(id), 'has a space or a shell character'],
  [(id) => id.endsWith('.'), 'ends with a dot'],
  [(id) => DEVICE.test(stem(id)), 'is a reserved Windows device name'],
  [(id) => id.length > MAX_UNITS, `is longer than ${MAX_UNITS} characters`],
  [(id) => id !== id.normalize('NFC'), 'is not in Unicode NFC form'],
];

export function nameIssue(id: string): string | null {
  return RULES.find(([breaks]) => breaks(id))?.[1] ?? null;
}
