// mend: one command-line tool that applies the edits AI models write, in four formats, to a tree of files.
// It implements the whole of SPEC.md: the command line (section 1), output and exit codes (section 2),
// safe paths and file lines (section 3), format detection (section 4), three-tier line matching (section 5),
// unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9),
// and order plus all-or-nothing writes (section 10). Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split into lines, its line break, and whether it ends with one (section 3). */
interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileParts): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;
/** A successful move, for the `R <old> -> <new>` output line (section 2). */
interface Move {
  old: string;
  nw: string;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Section 5: matching lines ---------------------------------------------------------------

type Tier = 0 | 1 | 2;

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: Tier): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every 0-based position where O occurs in the file's lines at this tier; occurrences may overlap. */
function occurrences(fileLines: string[], O: string[], tier: Tier): number[] {
  const out: number[] = [];
  const n = O.length;
  if (n === 0) return out;
  // Only positions whose first line matches can start an occurrence; this keeps a long file fast
  // without changing which positions are returned, or their order.
  for (let i = 0; i + n <= fileLines.length; i += 1) {
    if (!lineEq(fileLines[i]!, O[0]!, tier)) continue;
    let ok = true;
    for (let j = 1; j < n; j += 1) {
      if (!lineEq(fileLines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (tier 0 only with --strict), or null. */
function findTier(fileLines: string[], O: string[], strict: boolean): { tier: Tier; pos: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(fileLines, O, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (its index into O) or an added line (its text). */
interface NEntry {
  text: string;
  ctx: number | null;
}

/**
 * Build the replacement lines for an occurrence at `at`: context lines are written as the file's own matched
 * line, never the patch's; at tier 2 every other line is re-indented (P, the leading whitespace of O's first
 * line, replaced by F, that of the file's first matched line); at tiers 0 and 1 lines are written as they are.
 */
function buildN(fileLines: string[], at: number, O: string[], N: NEntry[], tier: Tier): string[] {
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(fileLines[at] ?? '');
    P = leadingWs(O[0]!);
  }
  const out: string[] = [];
  for (const e of N) {
    if (e.ctx !== null) {
      out.push(fileLines[at + e.ctx]!);
      continue;
    }
    if (tier !== 2) {
      out.push(e.text);
      continue;
    }
    const t = e.text;
    if (t === '' || t.trim() === '') {
      out.push(t);
      continue;
    }
    out.push(t.startsWith(P) ? F + t.slice(P.length) : t);
  }
  return out;
}

function replaceAt(lines: string[], at: number, k: number, rep: string[]): string[] {
  return [...lines.slice(0, at), ...rep, ...lines.slice(at + k)];
}

// ---- Section 9: JSON edits -------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Section 6: unified diffs ----------------------------------------------------------------

/** One body line of a hunk: `raw` is the patch line as written ('' for a bare empty line). */
interface HunkLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
  raw: string;
}

interface Hunk {
  /** A: the hunk's old start line (1-based, from the header; B and D are not used). */
  A: number;
  lines: HunkLine[];
  /** O: the hunk's context and `-` lines, in body order. */
  oLines: string[];
  /** N: the hunk's context and `+` lines, in body order. */
  nLines: NEntry[];
  /** Whether a `\` line follows the hunk's last context or `+` line. */
  lastNoNl: boolean;
}

interface Section {
  diffOld: string | undefined;
  diffNew: string | undefined;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    diffOld: undefined,
    diffNew: undefined,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameFrom: undefined,
    renameTo: undefined,
    createFlag: false,
    deleteFlag: false,
    hunks: [],
  };
}

/** The path of a `--- ` / `+++ ` header line: text after the four characters, up to the first tab, trimmed. */
function parseDiffPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  if (t === '/dev/null') return null;
  return t;
}

function finishHunk(A: number, lines: HunkLine[]): Hunk {
  const oLines: string[] = [];
  const nLines: NEntry[] = [];
  for (const l of lines) {
    if (l.kind === 'ctx') {
      oLines.push(l.text);
      nLines.push({ text: l.text, ctx: oLines.length - 1 });
    } else if (l.kind === 'old') {
      oLines.push(l.text);
    } else {
      nLines.push({ text: l.text, ctx: null });
    }
  }
  let lastNoNl = false;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i]!;
    if (l.kind === 'ctx' || l.kind === 'new') {
      lastNoNl = l.noNl;
      break;
    }
  }
  return { A, lines, oLines, nLines, lastNoNl };
}

/** Apply one hunk to a file's parts; `d` is the length offset of this section's hunks applied so far. */
function applyUnifiedHunk(f: FileParts, h: Hunk, d: number, strict: boolean, path: string): FileParts {
  const O = h.oLines;
  const N = h.nLines;
  if (O.length === 0) {
    let pos = h.A + d;
    if (pos < 0) pos = 0;
    if (pos > f.lines.length) pos = f.lines.length;
    const rep = buildN(f.lines, pos, O, N, 0);
    const atEnd = pos === f.lines.length;
    const lines = [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos)];
    let final = f.final;
    if (atEnd && rep.length > 0) final = !h.lastNoNl;
    return { lines, br: f.br, final };
  }
  const found = findTier(f.lines, O, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const rep = buildN(f.lines, best, O, N, found.tier);
  const toEnd = best + O.length === f.lines.length;
  const lines = replaceAt(f.lines, best, O.length, rep);
  let final = f.final;
  if (toEnd) final = !h.lastNoNl;
  return { lines, br: f.br, final };
}

function unifiedSectionEdit(sec: Section, strict: boolean, moves: Move[]): Edit {
  const oldPath = sec.hasPair ? sec.pairOld : (sec.renameFrom !== undefined ? sec.renameFrom : (sec.diffOld ?? null));
  const newPath = sec.hasPair ? sec.pairNew : (sec.renameTo !== undefined ? sec.renameTo : (sec.diffNew ?? null));
  const isCreate = oldPath === null || sec.createFlag;
  const isDelete = !isCreate && (newPath === null || sec.deleteFlag);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return (tree) => {
    if (isCreate) {
      if (newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: HunkLine[] = [];
      for (const h of sec.hunks) for (const l of h.lines) if (l.kind === 'new') plus.push(l);
      const lastPlus = plus.length > 0 ? plus[plus.length - 1]! : null;
      const final = lastPlus !== null ? !lastPlus.noNl : false;
      tree.now.set(newPath, plus.length === 0 ? '' : plus.map((p) => p.text).join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const src = oldPath!;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (isMove) {
      if (!safe(newPath!)) throw new Fail('unsafe', newPath!);
    }
    const cur = tree.get(src);
    if (cur === null) throw new Fail('missing', src);
    if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    let f = splitFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyUnifiedHunk(f, h, d, strict, src);
      d += h.nLines.length - h.oLines.length;
    }
    const out = joinFile(f);
    if (isMove) {
      tree.now.set(newPath!, out);
      tree.now.set(src, null);
      moves.push({ old: src, nw: newPath! });
    } else {
      tree.now.set(src, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = parseDiffPath(l);
      const newP = parseDiffPath(lines[i + 1]!);
      if (cur !== null && inHeader && !cur.hasPair) {
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.pairOld = oldP;
        cur.pairNew = newP;
        cur.hasPair = true;
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      i += 1;
      const body: HunkLine[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') {
          body.push({ kind: 'ctx', text: '', noNl: false, raw: '' });
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ') {
          body.push({ kind: 'ctx', text: b.slice(1), noNl: false, raw: b });
          i += 1;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'old', text: b.slice(1), noNl: false, raw: b });
          i += 1;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'new', text: b.slice(1), noNl: false, raw: b });
          i += 1;
          continue;
        }
        if (c === '\\') {
          if (body.length > 0) body[body.length - 1]!.noNl = true;
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      cur.hunks.push(finishHunk(parseInt(m[1]!, 10), body));
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.createFlag = true;
      else if (l.startsWith('deleted file mode')) cur.deleteFlag = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

// ---- Section 7: SEARCH/REPLACE blocks ----------------------------------------------------------

interface SrBlock {
  path: string;
  searchLine: number;
  oldLines: string[];
  newLines: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let lastEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j >= lastEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, searchLine, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    lastEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => {
    const path = b.path;
    const oldLines = b.oldLines;
    const newLines = b.newLines;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(path);
      if (cur === null) throw new Fail('missing', path);
      const f = splitFile(cur);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.pos.length > 1) throw new Fail('ambiguous', path);
      const rep = buildN(f.lines, found.pos[0]!, oldLines, newLines.map((t) => ({ text: t, ctx: null })), found.tier);
      tree.now.set(path, joinFile({ lines: replaceAt(f.lines, found.pos[0]!, oldLines.length, rep), br: f.br, final: f.final }));
    };
  });
}

// ---- Section 8: V4A patches --------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NEntry[];
}

function v4aChunkON(body: string[]): { O: string[]; N: NEntry[] } {
  const O: string[] = [];
  const N: NEntry[] = [];
  for (const b of body) {
    if (b === '') {
      O.push('');
      N.push({ text: '', ctx: O.length - 1 });
    } else if (b[0] === ' ') {
      const t = b.slice(1);
      O.push(t);
      N.push({ text: t, ctx: O.length - 1 });
    } else if (b[0] === '-') {
      O.push(b.slice(1));
    } else if (b[0] === '+') {
      N.push({ text: b.slice(1), ctx: null });
    }
  }
  return { O, N };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean, moves: Move[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    const tiers: Tier[] = strict ? [0] : [0, 1, 2];
    let f = splitFile(cur);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        let foundAt = -1;
        for (const t of tiers) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (lineEq(f.lines[k]!, chunk.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const O = chunk.O;
      const N = chunk.N;
      if (O.length === 0) {
        const pos = chunk.eof ? f.lines.length : cursor;
        const rep = buildN(f.lines, pos, O, N, 0);
        f = { lines: [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos)], br: f.br, final: f.final };
        cursor = pos + rep.length;
        continue;
      }
      let found: { tier: Tier; at: number } | null = null;
      for (const t of tiers) {
        const pos = occurrences(f.lines, O, t).filter((p) => p >= cursor);
        if (chunk.eof) {
          const atEnd = pos.filter((p) => p + O.length === f.lines.length);
          if (atEnd.length > 0) {
            found = { tier: t, at: atEnd[0]! };
            break;
          }
        } else if (pos.length > 0) {
          found = { tier: t, at: pos[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const rep = buildN(f.lines, found.at, O, N, found.tier);
      f = { lines: replaceAt(f.lines, found.at, O.length, rep), br: f.br, final: f.final };
      cursor = found.at + rep.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push({ old: path, nw: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aSectionEdit(kind: string, path: string, raw: string[], headerLine: number, strict: boolean, moves: Move[]): Edit {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (let j = 0; j < raw.length; j += 1) {
      const l = raw[j]!;
      if (l === '') fileLines.push('');
      else if (l.startsWith('+')) fileLines.push(l.slice(1));
      else throw new Exit2(`error: parse ${headerLine + 2 + j}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (let j = 0; j < raw.length; j += 1) {
      if (!blank(raw[j]!)) throw new Exit2(`error: parse ${headerLine + 2 + j}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  while (idx < raw.length) {
    const l = raw[idx]!;
    let anchor: string | null = null;
    let eof = false;
    if (l.startsWith('@@')) {
      anchor = l.slice(2).trim();
      idx += 1;
    } else if (chunks.length !== 0) {
      throw new Exit2(`error: parse ${headerLine + 2 + idx}`);
    }
    const body: string[] = [];
    while (idx < raw.length) {
      const b = raw[idx]!;
      if (b === '*** End of File') {
        eof = true;
        idx += 1;
        break;
      }
      if (b.startsWith('@@')) break;
      if (b.startsWith('*** ')) throw new Exit2(`error: parse ${headerLine + 2 + idx}`);
      if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
        body.push(b);
        idx += 1;
        continue;
      }
      throw new Exit2(`error: parse ${headerLine + 2 + idx}`);
    }
    const on = v4aChunkON(body);
    chunks.push({ anchor, eof, O: on.O, N: on.N });
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine + 1}`);
  return v4aUpdateEdit(path, moveTo, chunks, strict, moves);
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: string;
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice('*** Add File: '.length).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice('*** Delete File: '.length).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i;
    i += 1;
    const raw: string[] = [];
    while (i < last) {
      const r = lines[i]!;
      if (r.startsWith('*** Add File: ') || r.startsWith('*** Delete File: ') || r.startsWith('*** Update File: ')) break;
      raw.push(r);
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
    edits.push(v4aSectionEdit(kind, path, raw, headerLine, strict, moves));
  }
  return edits;
}

// ---- Section 10: order, atomicity, output ------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rByNew = new Map<string, string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rByNew.set(m.nw, m.old);
    }
  }
  const rOlds = new Set<string>([...rByNew.values()]);
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!check) {
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
    if (rOlds.has(p)) continue;
    if (rByNew.has(p)) rows.push({ key: p, line: `R ${rByNew.get(p)} -> ${p}` });
    else rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
