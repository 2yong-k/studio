// The guard's readings of a command's text: the words a shell, PowerShell or cmd.exe runs once quoting, parameters and
// substitutions that give nothing, decoded escapes and brace expansion are read, and the path segments of a glob read as
// patterns. Plain code with no imports, so the guard hook loads it without config.ts.

// Read backslash pairs left to right as the shell does: a backslash-newline pair goes and joins the halves
// (`secu\<newline>rity` is `security`), while `\\` keeps the newline after it a newline.
const BACKSLASH_PAIR = /\\([\s\S])/g;
// A parameter such as `$X` or `$1` may expand to nothing, so it breaks words before the quotes around it go:
// `"$X"-w` is `-w`. A name runs on over letters, digits and `_`; `$1`, `$@` and the like end after one character.
// (`${X}` already breaks at `$`, `{` and `}`.)
const PARAMETER = /\$(?:[A-Za-z_]\w*|[0-9@*#?!$])?/g;
// Quotes and backslashes only join or escape letters for the shell, so without them `sec\urity`, `"sec""urity"` and
// `-"w"` read as the words the shell runs.
const QUOTING = /['"\\]/g;
// Shell punctuation and brace expansion break words too, so the flags inside `$(…)`, backticks, `bash -c '…'` and
// `{a,b}` stand alone.
export const WORD_BREAK = /[\s;|&()<>$`{},]+/;
// PowerShell escapes the next letter with a backtick and joins strings with `+`, so ``provider`-key.json`` and
// `'provider-' + 'key.json'` name the key file once both go.
const BACKTICK = /`/g;
// A substitution that may give nothing: `${…}`, `$(…)` and a backtick pair. It holds no parentheses or braces, so
// nested ones go innermost first, one level a pass.
const SUBSTITUTION = /\$\{[^{}]*\}|\$\([^()]*\)|`[^`]*`/g;
// Nothing ordinary nests substitutions this deep. A hook that fails or runs past its time limit lets the call through,
// so text nested deeper gets no readings and the guard refuses it unread, rather than read one level at a time.
const SUBSTITUTION_PASSES = 32;
// Quoting that the shell decodes before anything runs, so a letter may be spelled by its code: bash's `$'…'` (`\x70`,
// `\160`, `\u0070`, `\U00000070`, `\n`) and PowerShell's `u{70}.
const ANSI_C = /\$'((?:[^'\\]|\\[\s\S])*)'/g;
const ANSI_C_ESCAPE = /\\(x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[0-7]{1,3}|[\s\S])/g;
const OCTAL = /^[0-7]/;
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};
const POWERSHELL_UNICODE = /`u\{([0-9A-Fa-f]{1,6})\}/g;
const CARET = /\^/g;
// Brace expansion runs before the other expansions, so a group can split a name that the shell then joins:
// `pro{vider,}-key.json` is `provider-key.json pro-key.json`. Each word is expanded on its own, and a substitution's
// text is a command with words of its own.
const BRACE_BREAK = /[\s;|&()<>`]+/g;
// A backslash and the letter after it, single quotes and bash's `$'…'`, each to its close or the end.
const QUOTED = /\\[\s\S]?|'[^']*'?|\$'(?:[^'\\]|\\[\s\S])*'?/y;
// A word past a cap, or nested deeper, stays as written: refusing it would refuse ordinary minified JSON, which can hold
// trillions of variants. Words go cheapest first until the total, so a long command stays quick to judge.
const BRACE_VARIANTS = 4096;
const BRACE_WORD_CHARS = 1 << 18;
const BRACE_TOTAL_CHARS = 1 << 22;
const BRACE_DEPTH = 32;
// Longer than any sequence worth reading, such as `-1000000..1000000..100`, once its quoting is gone.
const SEQUENCE_CHARS = 32;
// bash reads a sequence between two letters, and zsh between any two characters, quoted or not: `{-..-}` and
// `{"-"..-}` are both `-` there.
const CHARACTER_SEQUENCE = /^[\s\S]\.\.[\s\S](?:\.\.[+-]?\d+)?$/;
const NUMBER_SEQUENCE = /^[+-]?\d+\.\.[+-]?\d+(?:\.\.[+-]?\d+)?$/;
const ZERO = '0'.charCodeAt(0);
// Words for the glob reading break at the shell's plain breaks only, so a zsh group `(a|b)` and a bracket `[,]` stay
// whole.
const GLOB_WORD_BREAK = /[\s;&<>`]+/;
const GLOB_SYNTAX = /[*?[(]/;
export const hasGlob = (text: string): boolean => GLOB_SYNTAX.test(text);
// Groups nested deeper than this read as `*`, which matches more, so judging a crafted word stays shallow.
const GLOB_DEPTH = 32;
// Both separators count on every OS, so a Windows spelling is judged the same wherever the guard runs.
export const SEPARATOR = /[\\/]/;

// A backslash is an escape for a POSIX shell and a separator for Windows: `backslash` is what it becomes.
function normalise(command: string, parameter = ' ', backslash = ''): string {
  return command
    .replace(BACKSLASH_PAIR, (pair: string, c: string) => (c === '\n' ? '' : pair))
    .replace(PARAMETER, parameter)
    .replace(QUOTING, (q: string) => (q === '\\' ? backslash : ''));
}

// The pieces around each `+` lose the spaces that face it. A regex such as `\s*\+\s*` would backtrack over a long run of
// spaces with no `+` after it.
function joined(command: string): string {
  const pieces = command.replace(BACKTICK, '').split('+');
  const last = pieces.length - 1;
  return pieces
    .map((piece, i) => {
      const start = i === 0 ? piece : piece.trimStart();
      return i === last ? start : start.trimEnd();
    })
    .join('');
}

// A code past the last code point decodes to nothing.
function character(code: string, radix: number): string {
  const point = Number.parseInt(code, radix);
  return point <= 0x10ffff ? String.fromCodePoint(point) : '';
}

// Any other escaped letter stands for itself (`\\`, `\'`).
function ansiC(sequence: string): string {
  const kind = sequence.charAt(0);
  if (sequence.length > 1 && 'xuU'.includes(kind)) return character(sequence.slice(1), 16);
  if (OCTAL.test(sequence)) return character(sequence, 8);
  return CONTROL_ESCAPES[kind] ?? kind;
}

function decoded(command: string): string {
  return command
    .replace(ANSI_C, (_quoted: string, body: string) =>
      body.replace(ANSI_C_ESCAPE, (_escaped: string, sequence: string) => ansiC(sequence)),
    )
    .replace(POWERSHELL_UNICODE, (_escaped: string, code: string) => character(code, 16));
}

// The run of characters at `i` and whether the shell reads it quoted. `open` holds each `"`, `(` and backtick not yet
// closed, innermost last; inside double quotes only a substitution is syntax again. A process substitution's `<(` or
// `>(` opens as one run.
function shellRun(text: string, i: number, open: string[]): [length: number, quoted: boolean] {
  const c = text.charAt(i);
  const top = open.at(-1);
  if (c === '"' || c === '`') {
    if (top === c) open.pop();
    else open.push(c);
    return [1, c === '"'];
  }
  if (top === '"') {
    if (!text.startsWith('$(', i)) return [c === '\\' ? 2 : 1, true];
    open.push('(');
    return [2, false];
  }
  QUOTED.lastIndex = i;
  const quoted = QUOTED.exec(text);
  if (quoted !== null) return [quoted[0].length, true];
  const processSubstitution = (c === '<' || c === '>') && text.charAt(i + 1) === '(';
  if (c === '(' || processSubstitution) open.push('(');
  else if (c === ')' && top === '(') open.pop();
  return [processSubstitution ? 2 : 1, false];
}

// The text as the shell reads its syntax: each quoted or escaped character becomes `_` in place, so
// `pro{vider,"x y"}-key.json` stays one word with one group and `pro{vider,"}"}` closes at its last brace. With
// `inWords`, each character inside parentheses or backticks goes the same way, as a substitution (`$(…)`, `$((…))`,
// `<(…)`, a backtick pair) is part of the word around it: `pro{vider,$((1))}-key.json` is one word with one group.
function syntaxOf(text: string, inWords = false): string {
  const open: string[] = [];
  let shape = '';
  let copied = 0;
  for (let i = 0; i < text.length; ) {
    const inside = open.length > 0;
    const [length, quoted] = shellRun(text, i, open);
    const end = Math.min(i + length, text.length);
    if (quoted || (inWords && (inside || open.length > 0))) {
      shape += text.slice(copied, i) + '_'.repeat(end - i);
      copied = end;
    }
    i = end;
  }
  return shape + text.slice(copied);
}

// Every character from one code to another, kept as its ends: a sequence may span thousands of them.
type Sequence = { first: number; last: number };
// Literal text, a sequence, or a group: its alternatives, each a list of parts.
type BracePart = string | Sequence | BracePart[][];
// A group's `sequence` is its body read as a sequence too, given as one more alternative when the group closes.
type BraceFrame = {
  from: number;
  to: number;
  alternatives: BracePart[][];
  parts: BracePart[];
  sequence: Sequence | null;
};

// Each `{` the shell pairs with a `}`, and the `{` that each comma lies directly inside.
function bracePairs(word: string): { close: Map<number, number>; owner: Map<number, number> } {
  const close = new Map<number, number>();
  const owner = new Map<number, number>();
  const open: number[] = [];
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    const from = c === '}' ? open.pop() : open.at(-1);
    if (c === '{') open.push(i);
    else if (c === '}' && from !== undefined) close.set(from, i);
    else if (c === ',' && from !== undefined) owner.set(i, from);
  }
  return { close, owner };
}

// The text of a brace body with its quoting gone, as zsh reads a sequence's ends, or null once it is longer than any
// sequence. It stops there, so each character of a crafted word is read by a few dozen braces at most.
function unquotedBody(word: string, from: number, to: number): string | null {
  let body = '';
  let single = false;
  for (let i = from; i < to && body.length <= SEQUENCE_CHARS; i++) {
    const c = word.charAt(i);
    if (c === "'") single = !single;
    else if (single || (c !== '"' && c !== '\\')) body += c;
    else if (c === '\\') body += word.charAt(++i);
  }
  return body.length <= SEQUENCE_CHARS ? body : null;
}

// A character sequence gives every character between its ends, whatever the step. A numeric one gives one digit, since
// no name the guard looks for holds one. Null for text that is not a sequence.
function sequenceOf(body: string | null): Sequence | null {
  if (body === null) return null;
  if (NUMBER_SEQUENCE.test(body)) return { first: ZERO, last: ZERO };
  if (!CHARACTER_SEQUENCE.test(body)) return null;
  const [a, b] = [body.charCodeAt(0), body.charCodeAt(3)];
  return { first: Math.min(a, b), last: Math.max(a, b) };
}

function characters({ first, last }: Sequence): string[] {
  const all: string[] = [];
  for (let code = first; code <= last; code++) all.push(String.fromCharCode(code));
  return all;
}

// A group is a paired `{…}` with a comma directly inside, or a sequence; any other brace is literal. A comma comes first,
// as in bash and zsh: `{,..A}` is the alternatives `` and `..A`, not a range from `,`. `shape` is the word as syntaxOf
// reads it, or the word itself. Only syntaxOf masks a quoted comma, so in the word itself a comma may be one that a
// nested shell reads quoted, as a zsh sequence end (`zsh -c "cat x{','..-}"`): with `bothWays`, a group whose body is
// also a sequence gives that sequence as one more alternative. Null when groups nest deeper than BRACE_DEPTH. One pass
// over the word, so a crafted word stays quick.
function braceParts(word: string, shape: string, bothWays: boolean): BracePart[] | null {
  const { close, owner } = bracePairs(shape);
  const separated = new Set(owner.values());
  const root: BraceFrame = { from: -1, to: word.length, alternatives: [], parts: [], sequence: null };
  const parents: BraceFrame[] = [];
  let frame = root;
  let start = 0;
  const flush = (end: number): void => {
    if (end > start) frame.parts.push(word.slice(start, end));
    start = end + 1;
  };
  for (let i = 0; i < word.length; i++) {
    if (i === frame.to) {
      flush(i);
      frame.alternatives.push(frame.parts);
      if (frame.sequence !== null) frame.alternatives.push([frame.sequence]);
      const group = frame.alternatives;
      frame = parents.pop() ?? root;
      frame.parts.push(group);
    } else if (shape[i] === ',' && owner.get(i) === frame.from) {
      flush(i);
      frame.alternatives.push(frame.parts);
      frame.parts = [];
    } else if (shape[i] === '{') {
      const to = close.get(i);
      if (to === undefined) continue;
      const sequence = sequenceOf(unquotedBody(word, i + 1, to));
      if (separated.has(i)) {
        if (parents.length === BRACE_DEPTH) return null;
        flush(i);
        parents.push(frame);
        frame = { from: i, to, alternatives: [], parts: [], sequence: bothWays ? sequence : null };
        continue;
      }
      if (sequence !== null) {
        flush(i);
        frame.parts.push(sequence);
        i = to;
        start = to + 1;
      }
    }
  }
  flush(word.length);
  return root.parts;
}

// Stops counting past BRACE_VARIANTS.
function variantCount(parts: readonly BracePart[]): number {
  let count = 1;
  for (const part of parts) {
    if (typeof part === 'string') continue;
    const sum = Array.isArray(part)
      ? part.reduce((total, alternative) => total + variantCount(alternative), 0)
      : part.last - part.first + 1;
    count = Math.min(count * sum, BRACE_VARIANTS + 1);
  }
  return count;
}

function variants(parts: readonly BracePart[]): string[] {
  let heads = [''];
  for (const part of parts) {
    const tails = typeof part === 'string' ? [part] : Array.isArray(part) ? part.flatMap(variants) : characters(part);
    heads = heads.flatMap((head) => tails.map((tail) => head + tail));
  }
  return heads;
}

// A word's groups and what its variants cost, or null for a word that stays as written. Read as sequences too, groups
// can pass a cap that they stay under alone (`{,..€}`), so the word is read again as groups alone, as the shell reads an
// unquoted comma.
function wordParts(word: string, shape: string): { parts: BracePart[]; cost: number } | null {
  if (!shape.includes('{')) return null;
  for (const bothWays of [true, false]) {
    const parts = braceParts(word, shape, bothWays);
    if (parts === null || parts.every((part) => typeof part === 'string')) return null;
    const count = variantCount(parts);
    const cost = count * shape.length;
    if (count <= BRACE_VARIANTS && cost <= BRACE_WORD_CHARS) return { parts, cost };
  }
  return null;
}

// Each word with a group becomes its variants, as the shell runs them. `syntax` is the text as syntaxOf reads it, or the
// text itself to read every brace and break as syntax.
function expanded(text: string, syntax: string): string {
  if (!syntax.includes('{')) return text;
  const words: string[] = [];
  const groups: { at: number; parts: BracePart[]; cost: number }[] = [];
  const addWord = (start: number, end: number): void => {
    const word = wordParts(text.slice(start, end), syntax.slice(start, end));
    words.push(text.slice(start, end));
    if (word !== null) groups.push({ at: words.length - 1, ...word });
  };
  let start = 0;
  for (const gap of syntax.matchAll(BRACE_BREAK)) {
    addWord(start, gap.index);
    start = gap.index + gap[0].length;
    words.push(text.slice(gap.index, start));
  }
  addWord(start, syntax.length);
  let total = 0;
  for (const { at, parts, cost } of groups.sort((a, b) => a.cost - b.cost)) {
    total += cost;
    if (total > BRACE_TOTAL_CHARS) break;
    words[at] = variants(parts).join(' ');
  }
  return words.join('');
}

// Null when substitutions are still nested after the passes.
function withoutSubstitutions(command: string): string | null {
  let text = command;
  for (let pass = 0; pass <= SUBSTITUTION_PASSES; pass++) {
    const once = text.replace(SUBSTITUTION, '');
    if (once === text) return text;
    text = once;
  }
  return null;
}

// A glob segment read as the shell matches a file name: `*`, `?`, a bracket, and zsh's group `(a|b)`.
type GlobToken =
  | { kind: 'star' }
  | { kind: 'one'; test: (c: string) => boolean }
  | { kind: 'group'; alternatives: GlobToken[][]; optional: boolean };
type GlobLexeme = GlobToken | { kind: 'open' } | { kind: 'close' } | { kind: 'bar' };

const STAR: GlobToken = { kind: 'star' };
const literal = (letter: string): GlobToken => ({ kind: 'one', test: (c) => c === letter });

const isClassKind = (c: string): boolean => c !== '' && ':=.'.includes(c);

// Where a bracket's members run for each index of a segment: `classClose`, for a class such as `[:punct:]` starting
// there, the index of its `:]` (or -1); `ends`, for members read from there, the index of the `]` that closes them (or
// -1). Built from the end, so a segment full of `[` that never closes stays linear.
type BracketTable = { classClose: Int32Array; ends: Int32Array };

// The next member after the one at `i`: a class, a range `a-z`, or one letter.
function memberEnd(segment: string, i: number, classClose: Int32Array): number {
  const close = classClose[i] ?? -1;
  if (close !== -1) return close + 2;
  const after = segment.charAt(i + 2);
  return segment.charAt(i + 1) === '-' && after !== '' && after !== ']' ? i + 3 : i + 1;
}

function bracketTable(segment: string): BracketTable {
  const classClose = new Int32Array(segment.length).fill(-1);
  const ends = new Int32Array(segment.length + 3).fill(-1);
  const nearest = new Map<string, number>();
  for (let i = segment.length - 1; i >= 0; i--) {
    const kind = segment.charAt(i + 2);
    if (isClassKind(kind) && segment.charAt(i + 3) === ']') nearest.set(kind, i + 2);
    const next = segment.charAt(i + 1);
    if (segment.charAt(i) === '[' && isClassKind(next)) classClose[i] = nearest.get(next) ?? -1;
    ends[i] = segment.charAt(i) === ']' ? i : (ends[memberEnd(segment, i, classClose)] ?? -1);
  }
  return { classClose, ends };
}

// A bracket at `from` and the index of its `]`, or null when it never closes (then `[` is a letter). `!` or `^` first
// negates it, a `]` first is a member, and a class reads as any character, which matches more.
function bracket(
  segment: string,
  from: number,
  table: BracketTable,
): [test: (c: string) => boolean, end: number] | null {
  let i = from + 1;
  const negated = segment.charAt(i) === '!' || segment.charAt(i) === '^';
  if (negated) i++;
  const end = (segment.charAt(i) === ']' ? table.ends[memberEnd(segment, i, table.classClose)] : table.ends[i]) ?? -1;
  if (end === -1) return null;
  const ranges: [low: string, high: string][] = [];
  let any = false;
  for (let j = i; j < end; ) {
    const next = memberEnd(segment, j, table.classClose);
    const [low, high] = [segment.charAt(j), segment.charAt(next - 1)];
    if ((table.classClose[j] ?? -1) !== -1) any = true;
    else ranges.push(low <= high ? [low, high] : [high, low]);
    j = next;
  }
  const test = any ? () => true : (c: string) => ranges.some(([low, high]) => c >= low && c <= high) !== negated;
  return [test, end];
}

function globLexemes(segment: string): GlobLexeme[] {
  const lexemes: GlobLexeme[] = [];
  const table = segment.includes('[') ? bracketTable(segment) : null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charAt(i);
    const found = c === '[' && table !== null ? bracket(segment, i, table) : null;
    if (found !== null) {
      lexemes.push({ kind: 'one', test: found[0] });
      i = found[1];
    } else if (c === '*') lexemes.push(STAR);
    else if (c === '?') lexemes.push({ kind: 'one', test: () => true });
    else if (c === '(') lexemes.push({ kind: 'open' });
    else if (c === ')') lexemes.push({ kind: 'close' });
    else if (c === '|') lexemes.push({ kind: 'bar' });
    else lexemes.push(literal(c));
  }
  return lexemes;
}

// A parenthesis with no partner in its segment belongs to the command around the word (a subshell, a call) and is
// dropped; a `|` outside a group is a letter. A group without `|` may be zsh's glob qualifiers, which match nothing, so
// it is optional.
function globTokens(segment: string): GlobToken[] {
  const lexemes = globLexemes(segment);
  const paired = new Set<number>();
  const opens: number[] = [];
  lexemes.forEach((lexeme, i) => {
    const from = lexeme.kind === 'close' ? opens.pop() : undefined;
    if (lexeme.kind === 'open') opens.push(i);
    else if (from !== undefined) paired.add(from).add(i);
  });
  type Frame = { alternatives: GlobToken[][]; tokens: GlobToken[]; bar: boolean };
  const root: Frame = { alternatives: [], tokens: [], bar: false };
  const frames: Frame[] = [];
  let frame = root;
  lexemes.forEach((lexeme, i) => {
    if (lexeme.kind === 'open' || lexeme.kind === 'close') {
      if (!paired.has(i)) return;
      if (lexeme.kind === 'open') {
        frames.push(frame);
        frame = { alternatives: [], tokens: [], bar: false };
        return;
      }
      const group = frame;
      group.alternatives.push(group.tokens);
      frame = frames.pop() ?? root;
      const deep = frames.length >= GLOB_DEPTH;
      frame.tokens.push(deep ? STAR : { kind: 'group', alternatives: group.alternatives, optional: !group.bar });
    } else if (lexeme.kind === 'bar') {
      if (frame === root) frame.tokens.push(literal('|'));
      else {
        frame.alternatives.push(frame.tokens);
        frame.tokens = [];
        frame.bar = true;
      }
    } else frame.tokens.push(lexeme);
  });
  return root.tokens;
}

// The positions in `name` that the tokens reach from the positions in `from`, one bit each (bit p: p letters matched),
// so no pattern backtracks. Names stay shorter than 31 letters.
function reach(tokens: readonly GlobToken[], name: string, from: number): number {
  const all = (2 << name.length) - 1;
  let at = from;
  for (const token of tokens) {
    if (at === 0) return 0;
    if (token.kind === 'star') at = all & ~((at & -at) - 1);
    else if (token.kind === 'group') {
      at = token.alternatives.reduce((sum, alternative) => sum | reach(alternative, name, at), token.optional ? at : 0);
    } else {
      let next = 0;
      for (let p = 0; p < name.length; p++) if ((at >> p) & 1 && token.test(name.charAt(p))) next |= 2 << p;
      at = next;
    }
  }
  return at;
}

export function globMatcher(segment: string): (name: string) => boolean {
  const tokens = globTokens(segment);
  return (name) => ((reach(tokens, name, 1) >> name.length) & 1) === 1;
}

// A word's path segments as the file system walks them: an empty or `.` segment names the same folder, `..` the one
// above.
export function pathSegments(word: string): string[] {
  const kept: string[] = [];
  for (const segment of word.split(SEPARATOR)) {
    if (segment === '..' && kept.length > 0 && kept.at(-1) !== '..') kept.pop();
    else if (segment !== '' && segment !== '.') kept.push(segment);
  }
  return kept;
}

// Past the plain breaks (`&` and `;` among them), shell syntax glued to a word can end the path a qualifier `(D)` closes
// while a zsh group `(a|b)` or the qualifier keeps its `|` and `)`: a `|`, a `)` that closes a subshell or a
// substitution around the word, a `}` that closes a zsh brace group, and the `)` of a group the word opens itself (a
// zsh array `a=(…)`, a short `for f (…)`). The pieces of a word between the first three outside any paired group, and
// the text inside each outermost group, so a qualifier is read at the end of its piece (`*(D)|head`, `$(cat *(D))`,
// `{cat *(D)}`, `a=(*(D))`). Outermost groups do not overlap, so this stays one pass over the word.
function shellPieces(word: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  let group = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word.charAt(i);
    if (c === '(') {
      if (depth === 0) group = i + 1;
      depth++;
    } else if (c === ')' && depth > 0) {
      depth--;
      if (depth === 0) pieces.push(word.slice(group, i));
    } else if (depth === 0 && (c === ')' || c === '|' || c === '}')) {
      pieces.push(word.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(word.slice(start));
  return pieces;
}

// The words of a text that hold glob syntax, split as the other rules split them, at plain breaks only, and into the
// pieces the shell reads between its syntax.
export function globWords(text: string): string[] {
  if (!hasGlob(text)) return [];
  const plain = text.split(GLOB_WORD_BREAK);
  return [...text.split(WORD_BREAK), ...plain, ...plain.flatMap(shellPieces)].filter(hasGlob);
}

// A shell matches a leading dot only by a dot, which zsh also takes from a group (`(.c*|x)`).
export const dotLed = (segment: string): boolean => segment.startsWith('.') || segment.startsWith('(');

// bash's dotglob (which setting GLOBIGNORE turns on) and zsh's globdots let `*` match a leading dot. zsh ignores case
// and underscores in an option's name, and the text is folded.
const DOT_OPTION = /dotglob|globdots|globignore/;
export const setsDotOption = (lower: string): boolean => DOT_OPTION.test(lower.replaceAll('_', ''));

const NOT_QUALIFIERS = /[()|]/;
const SEPARATORS = new RegExp(SEPARATOR.source, 'g');

// zsh reads a run of groups without `|` at the end of a word as glob qualifiers (`(N)`, `(.D)`, `(#qN)(#qD)`), and `D`
// among them lets `*` match a leading dot. The word with the separators in that run dropped, since a qualifier such as
// `^/` names no folder, or null when no qualifier holds `d` (the word is folded). Each group is scanned once.
export function dotQualified(word: string): string | null {
  let end = word.length;
  let dots = false;
  while (word.endsWith(')', end)) {
    const open = word.lastIndexOf('(', end - 1);
    const group = word.slice(open + 1, end - 1);
    if (open === -1 || NOT_QUALIFIERS.test(group)) break;
    dots ||= group.includes('d');
    end = open;
  }
  return dots ? word.slice(0, end) + word.slice(end).replace(SEPARATORS, '') : null;
}

// A command, and the same with every parameter and substitution gone: one that gives nothing joins the halves around it
// into one word for the shell (`pro$@vider-key.json`, `secu$@rity`, `-$@w`), while reading it as a word break splits
// them.
export type Reading = { text: string; emptied: string };

// The forms of a reading the name rules judge, with a backslash as `backslash`. cmd.exe drops a caret before an ordinary
// letter (`stu^dio-plugin`), so each form is read with its carets removed too.
export function nameForms({ text, emptied }: Reading, backslash = ''): string[] {
  return [
    normalise(joined(text), ' ', backslash),
    normalise(text, ' ', backslash),
    normalise(joined(emptied), '', backslash),
    normalise(emptied, '', backslash),
  ].flatMap((form) => (form.includes('^') ? [form, form.replace(CARET, '')] : [form]));
}

// The forms of a reading the keychain rules judge.
export function keychainForms({ text, emptied }: Reading): string[] {
  return [normalise(text), normalise(emptied, '')];
}

// The shell expands braces in words it reads around quotes and substitutions, and decodes `$'…'` only after that.
function shellExpanded(text: string, inWords = false): string {
  return decoded(expanded(text, syntaxOf(text, inWords)));
}

// The command as written, with its escapes decoded, and with its braces expanded: as the shell reads them, with a
// substitution's text as a command and as part of its word (one may sit inside a group), once more without the
// substitutions, once more with `$'…'` decoded first (zsh reads `{$'\x2d'..-}` as `-`), and with every brace read as
// syntax, for a quote the shell does not read as one (in a comment or a here-document). Null when substitutions nest
// past the passes.
export function readings(command: string): Reading[] | null {
  const unescaped = decoded(command);
  const unsubstituted = withoutSubstitutions(command);
  if (unsubstituted === null) return null;
  const texts = [
    command,
    unescaped,
    expanded(unescaped, unescaped),
    shellExpanded(command),
    shellExpanded(command, true),
    shellExpanded(unsubstituted),
    shellExpanded(unescaped),
  ];
  const all: Reading[] = [];
  for (const text of new Set(texts)) {
    const emptied = withoutSubstitutions(text);
    if (emptied === null) return null;
    all.push({ text, emptied });
  }
  return all;
}
