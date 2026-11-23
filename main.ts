// mend: a command line tool that applies an edit written by an AI model to a
// tree of text files. The patch may be a unified diff, a set of SEARCH/REPLACE
// blocks, a V4A patch, or JSON edit objects; the tool reads it as SPEC.md
// describes, applies its edits in order, and writes the tree only when every
// edit succeeded. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// When MAKEFUN_ENV_URL is set, the run is a trial: the last lines below hand
// it over to runner.ts, which fetches the trial's checks, runs this file on
// each one, and posts the results back.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse or usage fault that ends the run with exit code 2 and one line. */
class Halt {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that could not be applied: its code and the path it concerns. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

function failParse(n: number): never {
  throw new Halt(`error: parse ${n}`);
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and the
 * empty piece after a final \n dropped. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 * and none of its /-separated segments is empty, . or ... */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Remove surrounding spaces (space characters only) from both ends. */
function trimSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === ' ') a += 1;
  while (b > a && s[b - 1] === ' ') b -= 1;
  return s.slice(a, b);
}

/** The leading spaces and tabs of a line. */
function leadingWs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

/** A file's own line break, its lines, and whether it ends with a break. A
 * file's break is CRLF when its first line feed follows a carriage return,
 * and LF otherwise; an empty file has no lines and no final break. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function fileState(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it. `now` holds the paths an edit touched
 * (null: deleted); anything else is read from disk as needed. `moves` records
 * the move edits that succeeded, so the final report can print R lines. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** How one line compares at a tier: tier 0 is the line itself, tier 1 drops
 * trailing spaces and tabs, tier 2 drops leading and trailing spaces and tabs. */
function keyAt(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which the
 * pattern occurs in the lines at or after `from`, and every such occurrence.
 * With `eofOnly`, only occurrences ending at the file's last line count. */
function firstTier(
  lines: string[],
  pat: string[],
  from: number,
  eofOnly: boolean,
  strict: boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const found: number[] = [];
    for (let i = from; i + pat.length <= lines.length; i += 1) {
      if (eofOnly && i + pat.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < pat.length; j += 1) {
        if (keyAt(lines[i + j] as string, t) !== keyAt(pat[j] as string, t)) {
          ok = false;
          break;
        }
      }
      if (ok) found.push(i);
    }
    if (found.length > 0) return { tier: t, positions: found };
  }
  return null;
}

/** The first line at or after `from` equal to the single-line anchor at the
 * first tier where one is, or null. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (keyAt(lines[i] as string, t) === keyAt(anchor, t)) return i;
    }
  }
  return null;
}

/** One line of a hunk body: context, an old line, a new line, or the
 * backslash marker that refers to the body line before it. `blank` records
 * that the patch line itself was empty (a line holding one space is a
 * context line whose text is empty, but it is not an empty line). */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
  blank: boolean;
}

function toBodyLine(l: string): BodyLine {
  if (l === '') return { kind: 'ctx', text: '', blank: true };
  if (l[0] === ' ') return { kind: 'ctx', text: l.slice(1), blank: false };
  if (l[0] === '-') return { kind: 'old', text: l.slice(1), blank: false };
  if (l[0] === '+') return { kind: 'new', text: l.slice(1), blank: false };
  return { kind: 'mark', text: l.slice(1), blank: false };
}

/** One line of the replacement: a context line, written as the file's own
 * matched line (oi is its index in the old lines), or a new line. */
interface NewLine {
  text: string;
  ctx: boolean;
  oi: number;
}

function hunkParts(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oi: o.length - 1 });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, ctx: false, oi: -1 });
    }
  }
  return { o, n };
}

/** Whether a backslash line follows the hunk's last context or new line. */
function markAfterLastAdded(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i]?.kind === 'ctx' || body[i]?.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === 'mark';
}

/** Re-indent one replacement line at tier 2: a line that is not empty and not
 * only whitespace, and starts with the pattern's leading whitespace, has
 * that replaced by the file's leading whitespace. */
function reindentLine(text: string, leadFile: string, leadPat: string): string {
  if (text === '' || text.trim() === '') return text;
  if (!text.startsWith(leadPat)) return text;
  return leadFile + text.slice(leadPat.length);
}

function renderNew(
  n: NewLine[],
  fileLines: string[],
  pos: number,
  tier: number,
  leadFile: string,
  leadPat: string,
): string[] {
  return n.map((nl) => {
    if (nl.ctx) return fileLines[pos + nl.oi] as string;
    if (tier === 2) return reindentLine(nl.text, leadFile, leadPat);
    return nl.text;
  });
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hasDash: boolean;
  seenHunk: boolean;
  hunks: Hunk[];
}

function newUniSection(gitOld: string | null, gitNew: string | null): UniSection {
  return {
    gitOld,
    gitNew,
    dashOld: null,
    dashNew: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hasDash: false,
    seenHunk: false,
    hunks: [],
  };
}

/** The path after `--- ` or `+++ `: the text after the four characters, up to
 * the first tab, with surrounding spaces removed. */
function dashPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return trimSpaces(tab >= 0 ? rest.slice(0, tab) : rest);
}

/** A leading a/ or b/ is removed from a ---/+++ path. */
function stripAb(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** A hunk applied to the lines it works on, which it updates in place along
 * with the running offset d and the file's final break. */
interface HunkState {
  lines: string[];
  final: boolean;
  d: number;
}

function applyHunk(st: HunkState, h: Hunk, strict: boolean, path: string): void {
  const { o, n } = hunkParts(h.body);
  if (o.length === 0) {
    const at = Math.max(0, Math.min(h.a + st.d, st.lines.length));
    const made = n.map((nl) => nl.text);
    const atEnd = at === st.lines.length;
    st.lines = [...st.lines.slice(0, at), ...made, ...st.lines.slice(at)];
    if (atEnd) st.final = !markAfterLastAdded(h.body);
    st.d += n.length;
    return;
  }
  const found = firstTier(st.lines, o, 0, false, strict);
  if (found === null) throw new EditFault('no-match', path);
  const target = h.a - 1 + st.d;
  let pos = found.positions[0] as number;
  let best = Math.abs(pos - target);
  for (const p of found.positions) {
    const dist = Math.abs(p - target);
    if (dist < best) {
      best = dist;
      pos = p;
    }
  }
  const atEnd = pos + o.length === st.lines.length;
  const made = renderNew(n, st.lines, pos, found.tier, leadingWs(st.lines[pos] as string), leadingWs(o[0] as string));
  st.lines = [...st.lines.slice(0, pos), ...made, ...st.lines.slice(pos + o.length)];
  if (atEnd) st.final = !markAfterLastAdded(h.body);
  st.d += n.length - o.length;
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.dashOld !== null ? stripAb(sec.dashOld) : (sec.renameFrom ?? sec.gitOld ?? '');
  const newP = sec.dashNew !== null ? stripAb(sec.dashNew) : (sec.renameTo ?? sec.gitNew ?? '');
  const oldIsNull = oldP === '/dev/null';
  const newIsNull = newP === '/dev/null';
  if (oldIsNull || sec.newFile) {
    return (tree) => {
      if (!isSafe(newP)) throw new EditFault('unsafe', newP);
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      const plus: string[] = [];
      let lastHunk: Hunk | null = null;
      let lastIdx = -1;
      for (const h of sec.hunks) {
        for (let i = 0; i < h.body.length; i += 1) {
          if (h.body[i]?.kind === 'new') {
            plus.push((h.body[i] as BodyLine).text);
            lastHunk = h;
            lastIdx = i;
          }
        }
      }
      const noBreak =
        lastHunk !== null && (lastHunk.body[lastIdx + 1]?.kind ?? '') === 'mark';
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
    };
  }
  if (newIsNull || sec.deletedFile) {
    return (tree) => {
      if (!isSafe(oldP)) throw new EditFault('unsafe', oldP);
      if (tree.get(oldP) === null) throw new EditFault('missing', oldP);
      tree.now.set(oldP, null);
    };
  }
  if (oldP !== newP) {
    return (tree) => {
      if (!isSafe(oldP)) throw new EditFault('unsafe', oldP);
      if (!isSafe(newP)) throw new EditFault('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new EditFault('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFault('exists', newP);
      const st = fileState(cur);
      const acc: HunkState = { lines: [...st.lines], final: st.final, d: 0 };
      for (const h of sec.hunks) applyHunk(acc, h, strict, oldP);
      tree.now.set(newP, joinFile(acc.lines, st.br, acc.final));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    };
  }
  return (tree) => {
    if (!isSafe(oldP)) throw new EditFault('unsafe', oldP);
    const cur = tree.get(oldP);
    if (cur === null) throw new EditFault('missing', oldP);
    const st = fileState(cur);
    const acc: HunkState = { lines: [...st.lines], final: st.final, d: 0 };
    for (const h of sec.hunks) applyHunk(acc, h, strict, oldP);
    tree.now.set(oldP, joinFile(acc.lines, st.br, acc.final));
  };
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const GIT_HEAD = /^diff --git a\/(\S+) b\/(\S+)$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hunk: Hunk | null = null;
  const closeHunk = (): void => {
    if (hunk === null) return;
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1] as BodyLine;
      if (last.kind === 'ctx' && last.blank) hunk.body.pop();
      else break;
    }
    hunk = null;
  };
  const nextIsPlusPlusPlus = (i: number): boolean => (lines[i + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (hunk !== null) {
      if (line.startsWith('--- ') && nextIsPlusPlusPlus(i)) {
        closeHunk();
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push(toBodyLine(line));
        i += 1;
        continue;
      }
      closeHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = GIT_HEAD.exec(line);
      if (m === null) failParse(i + 1);
      cur = newUniSection(m[1] as string, m[2] as string);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && nextIsPlusPlusPlus(i)) {
      if (cur !== null && !cur.seenHunk && !cur.hasDash) {
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1] as string);
        cur.hasDash = true;
      } else {
        cur = newUniSection(null, null);
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1] as string);
        cur.hasDash = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) failParse(i + 1);
      if (cur === null) failParse(i + 1);
      hunk = { a: parseInt(m[1] as string, 10), body: [] };
      cur.hunks.push(hunk);
      cur.seenHunk = true;
      i += 1;
      continue;
    }
    if (cur !== null && !cur.seenHunk) {
      if (line.startsWith('--- ')) failParse(i + 2);
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12);
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10);
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  closeHunk();
  if (sections.length === 0) failParse(1);
  return sections.map((s) => uniEdit(s, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    const st = fileState(cur);
    const found = firstTier(st.lines, oldLines, 0, false, strict);
    if (found === null) throw new EditFault('no-match', path);
    if (found.positions.length > 1) throw new EditFault('ambiguous', path);
    const pos = found.positions[0] as number;
    const made = newLines.map((t) =>
      found.tier === 2 ? reindentLine(t, leadingWs(st.lines[pos] as string), leadingWs(oldLines[0] as string)) : t,
    );
    const out = [...st.lines.slice(0, pos), ...made, ...st.lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, st.br, st.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if ((lines[i] as string).trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = (lines[j] as string).trimEnd();
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
      if (t === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) failParse(sIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      const t = (lines[j] as string).trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) failParse(sIdx + 1);
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevReplace; j -= 1) {
      const l = lines[j] as string;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) failParse(sIdx + 1);
      path = prevPath;
    }
    prevPath = path;
    edits.push(srEdit(path, lines.slice(sIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) failParse(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) !== null) throw new EditFault('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (tree.get(path) === null) throw new EditFault('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!isSafe(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFault('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const st = fileState(cur);
    let lines = [...st.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, cursor, strict);
        if (at === null) throw new EditFault('no-match', path);
        cursor = at + 1;
      }
      const { o, n } = hunkParts(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const made = n.map((nl) => nl.text);
        lines = [...lines.slice(0, at), ...made, ...lines.slice(at)];
        cursor = at + made.length;
        continue;
      }
      const found = firstTier(lines, o, cursor, ch.eof, strict);
      if (found === null) throw new EditFault('no-match', path);
      const pos = found.positions[0] as number;
      const made = renderNew(n, lines, pos, found.tier, leadingWs(lines[pos] as string), leadingWs(o[0] as string));
      lines = [...lines.slice(0, pos), ...made, ...lines.slice(pos + o.length)];
      cursor = pos + made.length;
    }
    const out = joinFile(lines, st.br, st.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File: ')) return 'add';
  if (line.startsWith('*** Delete File: ')) return 'delete';
  if (line.startsWith('*** Update File: ')) return 'update';
  return null;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) failParse(1);
  if ((lines[first] as string).trim() !== '*** Begin Patch') failParse(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i] as string)) {
      last = i;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') failParse(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i] as string;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = v4aSectionKind(line);
    if (kind === null) failParse(i + 1);
    const start = i;
    const secPath = trimSpaces(line.slice(kind === 'add' ? 14 : 17));
    let j = i + 1;
    while (j < last && v4aSectionKind(lines[j] as string) === null) j += 1;
    const raw = lines.slice(i + 1, j);
    while (raw.length > 0 && isBlank(raw[raw.length - 1] as string)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < raw.length; k += 1) {
        const l = raw[k] as string;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else failParse(start + 2 + k);
      }
      edits.push(v4aAddEdit(secPath, fileLines));
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (!isBlank(raw[k] as string)) failParse(start + 2 + k);
      }
      edits.push(v4aDeleteEdit(secPath));
    } else {
      let moveTo: string | null = null;
      let rest = raw;
      let base = start + 1;
      if (rest.length > 0 && (rest[0] as string).startsWith('*** Move to: ')) {
        moveTo = trimSpaces((rest[0] as string).slice(13));
        rest = rest.slice(1);
        base += 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      let seenChunk = false;
      for (let k = 0; k < rest.length; k += 1) {
        const l = rest[k] as string;
        const lineNo = base + 1 + k;
        if (l.startsWith('@@')) {
          const anchorText = trimSpaces(l.slice(2));
          chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(chunk);
          seenChunk = true;
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) failParse(lineNo);
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) {
            if (seenChunk) failParse(lineNo);
            chunk = { anchor: null, eof: false, body: [] };
            chunks.push(chunk);
            seenChunk = true;
          }
          chunk.body.push(toBodyLine(l));
          continue;
        }
        failParse(lineNo);
      }
      if (chunks.length === 0 && moveTo === null) failParse(start + 1);
      edits.push(v4aUpdateEdit(secPath, moveTo, chunks, strict));
    }
    i = j;
  }
  if (edits.length === 0) failParse(1);
  return edits;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. Keys other than the
 * ones below are ignored. */
function jsonEditObject(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!isSafe(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const st = fileState(before);
      if (lineNo < 0 || lineNo > st.lines.length) throw new EditFault('no-match', p);
      const out = [...st.lines];
      out.splice(lineNo, 0, ...add);
      tree.now.set(p, joinFile(out, st.br, st.final));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) failParse(1);
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      failParse(first + 1);
    }
    if (!Array.isArray(v)) failParse(first + 1);
    for (const x of v as unknown[]) {
      const e = jsonEditObject(x);
      if (e === null) failParse(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditObject(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) failParse(idx + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection, the run, and the trial hand-over                  */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const c = (lines[first] as string).trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, idx) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

interface RunResult {
  code: number;
  out: string[];
}

function run(args: string[]): RunResult {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice(9);
        if (format !== null || !KNOWN_FORMATS.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else if (a === '--check') {
        if (check) return { code: 2, out: ['error: usage'] };
        check = true;
      } else if (a === '--strict') {
        if (strict) return { code: 2, out: ['error: usage'] };
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Halt('error: parse 1');
  } catch (e) {
    if (e instanceof Halt) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const faults: EditFault[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      faults.push(e);
    }
  }
  if (faults.length > 0) {
    return {
      code: 1,
      out: [...faults.map((f) => `error: ${f.code} ${f.path}`), `failed: ${faults.length} of ${edits.length} edits`],
    };
  }
  const claimed = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [from, to] of tree.moves) {
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      claimed.add(from);
      claimed.add(to);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (claimed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p) as string | null;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p) as string | null;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable set.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
