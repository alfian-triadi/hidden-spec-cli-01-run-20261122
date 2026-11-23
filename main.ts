// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format (MIT). It does all ten
// sections of SPEC.md: the command line, the output and exit codes, safe paths, format detection, line matching at
// three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8),
// JSON edits (section 9) and the all-or-nothing write (section 10). Node 22, the standard library alone; run it as
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

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];
  /** The file's content on disk (null when absent), read lazily and cached on first access. */
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let diskText: string | null = null;
      try {
        if (statSync(p).isFile()) diskText = readFileSync(p, 'utf8');
      } catch {
        diskText = null;
      }
      this.orig.set(p, diskText);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

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

// ---------- Section 5: matching lines ----------

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions i >= from where O occurs in lines at the given tier. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const occ: number[] = [];
  if (o.length === 0) return occ;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) occ.push(i);
  }
  return occ;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs at least once at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Tier 2 re-indent (section 5): a line of N that is not empty and not only whitespace, and starts with P (the
 * leading spaces and tabs of O's first line), has that P replaced by F (those of the file's first matched line).
 */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new, '\' no-newline marker. */
type BodyLine = { kind: ' ' | '-' | '+' | '\\'; text: string };

/** O: the context and '-' lines of a hunk or chunk body, in order. */
function oldLinesOf(body: BodyLine[]): string[] {
  const o: string[] = [];
  for (const b of body) if (b.kind === ' ' || b.kind === '-') o.push(b.text);
  return o;
}

/**
 * N for a matched region at position pos: context lines are the file's own matched lines; every other line of N is
 * re-indented at tier 2 and written as it is at tiers 0 and 1.
 */
function newLinesOf(body: BodyLine[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  let oi = 0;
  for (const b of body) {
    if (b.kind === '\\') continue;
    if (b.kind === ' ') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (b.kind === '-') {
      oi += 1;
    } else if (b.kind === '+') {
      out.push(tier === 2 ? reindent(b.text, p, f) : b.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6, final line break). */
function backslashAfterLastCtxPlus(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) if (body[k]!.kind === ' ' || body[k]!.kind === '+') last = k;
  return last >= 0 && body[last + 1]?.kind === '\\';
}

// ---------- Section 6: unified diffs ----------

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  pair: boolean;
  dashOld: string | null;
  dashNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: UHunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A `--- ` or `+++ ` path: text after the four characters, up to the first tab, surrounding spaces removed. */
function dashPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function applyHunks(before: string, hunks: UHunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  const lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const o = oldLinesOf(h.body);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      const ins = newLinesOf(h.body, lines, at, 0, o);
      lines.splice(at, 0, ...ins);
      if (atEnd) final = !backslashAfterLastCtxPlus(h.body);
      d += ins.length;
      continue;
    }
    const found = findTier(lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const rep = newLinesOf(h.body, lines, best, found.tier, o);
    const touchesEnd = best + o.length === lines.length;
    lines.splice(best, o.length, ...rep);
    if (touchesEnd) final = !backslashAfterLastCtxPlus(h.body);
    d += rep.length - o.length;
  }
  return joinFile(lines, f.br, final);
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pair ? sec.dashOld : (sec.renFrom ?? sec.gitOld);
    const newP = sec.pair ? sec.dashNew : (sec.renTo ?? sec.gitNew);
    const isCreate = oldP === null || sec.createFlag;
    const isDelete = !isCreate && (newP === null || sec.deleteFlag);
    if (isCreate) {
      const np = newP ?? '';
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let bs = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const b = h.body[k]!;
          if (b.kind === '+') {
            plus.push(b.text);
            bs = h.body[k + 1]?.kind === '\\';
          }
        }
      }
      tree.now.set(np, joinFile(plus, '\n', !bs));
      return;
    }
    if (isDelete) {
      const op = oldP ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.move(oldP, newP, applyHunks(before, sec.hunks, strict, oldP));
      return;
    }
    const p = oldP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let sec: USection | null = null;
  let sawHunk = false;
  const newSection = (): USection => ({
    pair: false,
    dashOld: null,
    dashNew: null,
    renFrom: null,
    renTo: null,
    gitOld: null,
    gitNew: null,
    createFlag: false,
    deleteFlag: false,
    hunks: [],
  });
  const finish = (): void => {
    if (sec !== null) {
      edits.push(unifiedEdit(sec, strict));
      sec = null;
      sawHunk = false;
    }
  };
  const parseBody = (h: UHunk): void => {
    while (i < n) {
      const b = lines[i]!;
      if (b.startsWith('diff --git ')) break;
      if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
        h.body.push({ kind: b === '' ? ' ' : (b[0] as ' ' | '-' | '+' | '\\'), text: b === '' ? '' : b.slice(1) });
        i += 1;
      } else break;
    }
    while (h.body.length > 0) {
      const last = h.body[h.body.length - 1]!;
      if (last.kind === ' ' && last.text === '') h.body.pop();
      else break;
    }
  };
  const startHunk = (): void => {
    const m = HUNK_RE.exec(lines[i]!);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const h: UHunk = { a: parseInt(m[1]!, 10), body: [] };
    sec!.hunks.push(h);
    sawHunk = true;
    i += 1;
    parseBody(h);
  };
  while (i < n) {
    const l = lines[i]!;
    if (sec === null) {
      if (l.startsWith('diff --git ')) {
        const m = DIFF_GIT_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        sec = newSection();
        sec.gitOld = m[1]!;
        sec.gitNew = m[2]!;
        sawHunk = false;
        i += 1;
        continue;
      }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        sec = newSection();
        sawHunk = false;
        continue;
      }
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (!sawHunk) {
      if (l.startsWith('@@')) {
        startHunk();
        continue;
      }
      if (l.startsWith('diff --git ')) {
        finish();
        continue;
      }
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (sec.pair) {
            finish();
            continue;
          }
          sec.pair = true;
          sec.dashOld = dashPath(l);
          sec.dashNew = dashPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        sec.renFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.createFlag = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.deleteFlag = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      startHunk();
      continue;
    }
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      finish();
      continue;
    }
    i += 1;
  }
  finish();
  return edits;
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile(newLines, '\n', true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const lines = f.lines;
    const found = findTier(lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const p = leadWs(oldLines[0]!);
    const fl = leadWs(lines[pos]!);
    const rep = newLines.map((l) => (found.tier === 2 ? reindent(l, p, fl) : l));
    lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(lines, f.br, f.final));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= searchFrom; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------- Section 8: V4A patches ----------

interface VLine {
  line: string;
  idx: number;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: Array<{ kind: ' ' | '-' | '+'; text: string }>;
}

/** A section's lines up to the next section or `*** End Patch`, trailing blank lines removed. */
function collectVSection(lines: string[], start: number, endExclusive: number): { entries: VLine[]; next: number } {
  const entries: VLine[] = [];
  let j = start;
  while (j < endExclusive) {
    const l = lines[j]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
    entries.push({ line: l, idx: j });
    j += 1;
  }
  while (entries.length > 0 && blank(entries[entries.length - 1]!.line)) entries.pop();
  return { entries, next: j };
}

function updateFileEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    const lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const o = oldLinesOf(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const ins: string[] = [];
        for (const b of ch.body) if (b.kind === '+') ins.push(b.text);
        lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(lines, o, strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      let occs = found.occ;
      if (ch.eof) {
        occs = occs.filter((pos) => pos + o.length === lines.length);
        if (occs.length === 0) throw new Fail('no-match', path);
      }
      const pos = occs[0]!;
      const rep = newLinesOf(ch.body, lines, pos, found.tier, o);
      lines.splice(pos, o.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = joinFile(lines, f.br, f.final);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.now.set(path, out);
  };
}

function parseVUpdate(path: string, entries: VLine[], updateLineNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  let j = 0;
  if (j < entries.length && entries[j]!.line.startsWith('*** Move to: ')) {
    moveTo = entries[j]!.line.slice('*** Move to: '.length).trim();
    j += 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; j < entries.length; j++) {
    const e = entries[j]!;
    const line = e.line;
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(cur);
      continue;
    }
    if (line === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${e.idx + 1}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (cur === null) {
        if (chunks.length !== 0) throw new Exit2(`error: parse ${e.idx + 1}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
      }
      cur.body.push({ kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+'), text: line === '' ? '' : line.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${e.idx + 1}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return updateFileEdit(path, moveTo, chunks, strict);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const { entries, next } = collectVSection(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const e of entries) {
        if (e.line.startsWith('+')) fileLines.push(e.line.slice(1));
        else if (e.line === '') fileLines.push('');
        else throw new Exit2(`error: parse ${e.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile(fileLines, '\n', true));
      });
      i = next;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const { entries, next } = collectVSection(lines, i + 1, last);
      for (const e of entries) {
        if (blank(e.line)) continue;
        throw new Exit2(`error: parse ${e.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = next;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const { entries, next } = collectVSection(lines, i + 1, last);
      edits.push(parseVUpdate(path, entries, i + 1, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
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
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: Array<{ key: string; line: string }> = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (rOld.has(o) || rNew.has(n)) continue;
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      rOld.add(o);
      rNew.add(n);
    }
  }
  for (const p of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
