// main.ts is mend, the CLI SPEC.md specifies. It does all ten sections of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A
// patches, JSON edits and the all-or-nothing write. Node 22, the standard library alone; run it as
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as (old, new) pairs, for the `R old -> new` output lines. */
  readonly moves: [string, string][] = [];
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

/** SPEC section 3: a file's lines, its line break, and whether it ends with one. */
interface FileText {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}
function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** SPEC section 5: matching lines at three tiers. */
const rtrimWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWS(a) === rtrimWS(b);
  return trimWS(a) === trimWS(b);
}
/** Every 0-based position at which O's lines match the file's lines at the tier, from `from`. */
function occAt(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, or -1. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) if (occAt(lines, o, t, from).length > 0) return t;
  return -1;
}

/**
 * The lines that replace a match. `n` holds each new line with whether it is a context line and, for one,
 * its index in O. A context line is written as the file's own matched line; at tier 2 every other line is
 * re-indented from O's first line's leading whitespace to the file's first matched line's.
 */
function buildReplacement(
  n: { text: string; ctx: boolean; oIdx: number }[],
  fileLines: string[],
  pos: number,
  o: string[],
  tier: number,
): string[] {
  const f = leadWS(fileLines[pos] ?? '');
  const p = leadWS(o[0] ?? '');
  return n.map((l) => {
    if (l.ctx) return fileLines[pos + l.oIdx]!;
    if (tier === 2 && l.text !== '' && l.text.trim() !== '' && l.text.startsWith(p)) {
      return f + l.text.slice(p.length);
    }
    return l.text;
  });
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

/** SPEC section 6: unified diffs. */
interface HunkLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface Hunk {
  a: number;
  o: { text: string; ctx: boolean; oIdx: number }[];
  n: { text: string; ctx: boolean; oIdx: number }[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** The hunk has a `+` line, and a `\` line follows its last `+` line. */
  hasPlus: boolean;
  plusNoEol: boolean;
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.*?) b\/(.+)$/;

function diffPath(raw: string): string | null {
  let s = raw;
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

/** Apply one section's hunks, in order, to a file's text; throws Fail on a hunk failure. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  let f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const oTexts = h.o.map((x) => x.text);
    if (oTexts.length > 0) {
      const tier = findTier(f.lines, oTexts, strict);
      if (tier < 0) throw new Fail('no-match', path);
      const occs = occAt(f.lines, oTexts, tier);
      const target = h.a - 1 + d;
      let best = occs[0]!;
      for (const pos of occs) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const rep = buildReplacement(h.n, f.lines, best, oTexts, tier);
      const runsToEnd = best + oTexts.length === f.lines.length;
      f = {
        lines: [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + oTexts.length)],
        br: f.br,
        final: runsToEnd ? !h.noEol : f.final,
      };
      d += h.n.length - h.o.length;
    } else {
      const idx = Math.max(0, Math.min(h.a + d, f.lines.length));
      const rep = h.n.map((x) => x.text);
      const atEnd = idx === f.lines.length;
      f = {
        lines: [...f.lines.slice(0, idx), ...rep, ...f.lines.slice(idx)],
        br: f.br,
        final: atEnd ? !h.noEol : f.final,
      };
      d += h.n.length;
    }
  }
  return joinFile(f);
}

function unifiedEdit(s: UniSection, strict: boolean): Edit {
  return (tree) => {
    const paths = [s.oldPath, s.newPath].filter((p): p is string => p !== null);
    for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
    if (s.isCreate || s.oldPath === null) {
      const np = s.newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of s.hunks) for (const l of h.n) if (!l.ctx) plus.push(l.text);
      let noEol = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k]!.hasPlus) {
          noEol = s.hunks[k]!.plusNoEol;
          break;
        }
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (s.isDelete || s.newPath === null) {
      const op = s.oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = s.oldPath!;
    const np = s.newPath!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op !== np) {
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const after = applyHunks(before, s.hunks, strict, op);
      tree.now.set(np, after);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    tree.now.set(op, applyHunks(before, s.hunks, strict, op));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let hasPair = false;
  let curHunk: { a: number; body: HunkLine[] } | null = null;
  const finishHunk = (): void => {
    if (curHunk === null || cur === null) return;
    const body = curHunk.body;
    while (body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.kind === ' ' && last.text === '') body.pop();
      else break;
    }
    const o: Hunk['o'] = [];
    const n: Hunk['n'] = [];
    for (const bl of body) {
      if (bl.kind === ' ') {
        const idx = o.length;
        o.push({ text: bl.text, ctx: true, oIdx: idx });
        n.push({ text: bl.text, ctx: true, oIdx: idx });
      } else if (bl.kind === '-') {
        o.push({ text: bl.text, ctx: false, oIdx: -1 });
      } else if (bl.kind === '+') {
        n.push({ text: bl.text, ctx: false, oIdx: -1 });
      }
    }
    // A '\' line after the last context or '+' line means no trailing line break.
    let noEol = false;
    for (let k = body.length - 1; k >= 0; k--) {
      const bl = body[k]!;
      if (bl.kind === ' ' || bl.kind === '+') {
        noEol = k + 1 < body.length && body[k + 1]!.kind === '\\';
        break;
      }
    }
    // A '\' line after the last '+' line (for created files).
    let hasPlus = false;
    let plusNoEol = false;
    for (let k = body.length - 1; k >= 0; k--) {
      const bl = body[k]!;
      if (bl.kind === '+') {
        hasPlus = true;
        plusNoEol = k + 1 < body.length && body[k + 1]!.kind === '\\';
        break;
      }
    }
    cur.hunks.push({ a: curHunk.a, o, n, noEol, hasPlus, plusNoEol });
    curHunk = null;
  };
  const startSection = (): UniSection => {
    finishHunk();
    if (cur !== null) sections.push(cur);
    cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    inHeader = true;
    hasPair = false;
    return cur;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      if (line.startsWith('diff --git ')) {
        finishHunk();
      } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        finishHunk();
      } else if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        curHunk.body.push({
          kind: (line === '' ? ' ' : line[0]) as HunkLine['kind'],
          text: line === '' ? '' : line.slice(1),
        });
        i++;
        continue;
      } else {
        finishHunk();
      }
    }
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.oldPath = m[1]!;
      s.newPath = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && inHeader) {
          cur.oldPath = diffPath(line.slice(4));
          cur.newPath = diffPath(next.slice(4));
          hasPair = true;
        } else {
          const s = startSection();
          s.oldPath = diffPath(line.slice(4));
          s.newPath = diffPath(next.slice(4));
          hasPair = true;
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        if (!hasPair) cur.oldPath = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        if (!hasPair) cur.newPath = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      i++;
      continue;
    }
    i++;
  }
  finishHunk();
  if (cur !== null) sections.push(cur);
  return sections
    .filter((s) => s.oldPath !== null || s.newPath !== null)
    .map((s) => unifiedEdit(s, strict));
}

/** SPEC section 7: SEARCH/REPLACE blocks. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const tier = findTier(f.lines, oldLines, strict);
      if (tier < 0) throw new Fail('no-match', p);
      const occs = occAt(f.lines, oldLines, tier);
      if (occs.length > 1) throw new Fail('ambiguous', p);
      const pos = occs[0]!;
      const n = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const rep = buildReplacement(n, f.lines, pos, oldLines, tier);
      f.lines.splice(pos, oldLines.length, ...rep);
      tree.now.set(p, joinFile(f));
    });
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/** SPEC section 8: V4A patches. */
interface V4aChunk {
  anchor: string | null;
  o: { text: string; ctx: boolean; oIdx: number }[];
  n: { text: string; ctx: boolean; oIdx: number }[];
  eof: boolean;
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  headerLine: number;
  lines: string[];
  chunks: V4aChunk[];
}

function parseV4aChunks(raw: { line: string; idx: number }[]): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let cur: { anchor: string | null; body: { kind: ' ' | '-' | '+'; text: string }[]; eof: boolean } | null = null;
  const finish = (): void => {
    if (cur === null) return;
    const o: V4aChunk['o'] = [];
    const n: V4aChunk['n'] = [];
    for (const bl of cur.body) {
      if (bl.kind === ' ') {
        const idx = o.length;
        o.push({ text: bl.text, ctx: true, oIdx: idx });
        n.push({ text: bl.text, ctx: true, oIdx: idx });
      } else if (bl.kind === '-') {
        o.push({ text: bl.text, ctx: false, oIdx: -1 });
      } else {
        n.push({ text: bl.text, ctx: false, oIdx: -1 });
      }
    }
    chunks.push({ anchor: cur.anchor, o, n, eof: cur.eof });
    cur = null;
  };
  for (const { line, idx } of raw) {
    if (line.startsWith('@@')) {
      finish();
      const a = line.slice(2).trim();
      cur = { anchor: a === '' ? null : a, body: [], eof: false };
      continue;
    }
    if (line === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
      cur.eof = true;
      finish();
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) cur = { anchor: null, body: [], eof: false };
      cur.body.push({
        kind: (line === '' ? ' ' : line[0]) as ' ' | '-' | '+',
        text: line === '' ? '' : line.slice(1),
      });
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  finish();
  return chunks;
}

function v4aEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.lines.length === 0 ? '' : s.lines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      const oTexts = ch.o.map((x) => x.text);
      if (ch.anchor !== null) {
        const tier = findTier(f.lines, [ch.anchor], strict, cursor);
        if (tier < 0) throw new Fail('no-match', s.path);
        cursor = occAt(f.lines, [ch.anchor], tier, cursor)[0]! + 1;
      }
      if (oTexts.length > 0) {
        if (ch.eof) {
          const pos = f.lines.length - oTexts.length;
          if (pos < cursor) throw new Fail('no-match', s.path);
          let tier = -1;
          for (const t of strict ? [0] : [0, 1, 2]) {
            let ok = true;
            for (let k = 0; k < oTexts.length; k++) {
              if (!lineEq(f.lines[pos + k]!, oTexts[k]!, t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              tier = t;
              break;
            }
          }
          if (tier < 0) throw new Fail('no-match', s.path);
          const rep = buildReplacement(ch.n, f.lines, pos, oTexts, tier);
          f.lines.splice(pos, oTexts.length, ...rep);
          cursor = pos + rep.length;
        } else {
          const tier = findTier(f.lines, oTexts, strict, cursor);
          if (tier < 0) throw new Fail('no-match', s.path);
          const pos = occAt(f.lines, oTexts, tier, cursor)[0]!;
          const rep = buildReplacement(ch.n, f.lines, pos, oTexts, tier);
          f.lines.splice(pos, oTexts.length, ...rep);
          cursor = pos + rep.length;
        }
      } else {
        const idx = ch.eof ? f.lines.length : cursor;
        const rep = ch.n.map((x) => x.text);
        f.lines.splice(idx, 0, ...rep);
        cursor = idx + rep.length;
      }
    }
    const after = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, after);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, after);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last && blank(lines[i]!)) i++;
  while (i < last) {
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    i++;
    const sec: V4aSection = { kind, path, moveTo: null, headerLine, lines: [], chunks: [] };
    if (kind === 'add') {
      const raw: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('+')) raw.push(l.slice(1));
        else if (l === '') raw.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      sec.lines = raw;
    } else if (kind === 'delete') {
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (blank(l)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
    } else {
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const raw: { line: string; idx: number }[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        raw.push({ line: l, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.line)) raw.pop();
      sec.chunks = parseV4aChunks(raw);
      if (sec.chunks.length === 0 && sec.moveTo === null) {
        throw new Exit2(`error: parse ${headerLine}`);
      }
    }
    sections.push(sec);
    while (i < last && blank(lines[i]!)) i++;
  }
  return sections.map((s) => v4aEdit(s, strict));
}

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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
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
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) === tree.now.get(p)) continue;
    changed.push(p);
  }
  // A successful move is one `R old -> new` line (sorted by the new path), replacing its `D` and `A` lines.
  const movePairs = new Map<string, string>();
  const moveOlds = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.original(nw) === null && tree.now.get(old) === null && tree.now.get(nw) !== null) {
      movePairs.set(nw, old);
      moveOlds.add(old);
    }
  }
  const rows: { sort: string; line: string }[] = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (moveOlds.has(p)) continue;
    if (movePairs.has(p)) {
      rows.push({ sort: p, line: `R ${movePairs.get(p)} -> ${p}` });
      continue;
    }
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
