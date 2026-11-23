// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  readonly moves: Array<{ oldPath: string; newPath: string }> = [];
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

type LineMatch = { tier: number; positions: number[] } | null;

/** Find every (including overlapping) occurrence at the first matching tier. */
function matchLines(file: string[], oldLines: string[], _newLines: string[], _context: boolean[], strict: boolean): LineMatch {
  if (oldLines.length === 0) return null;
  const tiers: Array<(s: string) => string> = [
    (s) => s,
    (s) => s.replace(/[ \t]+$/g, ''),
    (s) => s.replace(/^[ \t]+|[ \t]+$/g, ''),
  ];
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier += 1) {
    const norm = tiers[tier]!;
    const positions: number[] = [];
    for (let i = 0; i + oldLines.length <= file.length; i += 1) {
      let equal = true;
      for (let j = 0; j < oldLines.length; j += 1) {
        if (norm(file[i + j]!) !== norm(oldLines[j]!)) {
          equal = false;
          break;
        }
      }
      if (equal) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Build replacement lines, retaining file spelling for marked context lines. */
function replacementLines(
  file: string[], oldLines: string[], newLines: string[], context: boolean[], tier: number, at: number,
  contextOldIndices?: Array<number | null>,
): string[] {
  const out = [...newLines];
  let oldCursor = 0;
  const fileIndent = (file[at]!.match(/^[ \t]*/) ?? [''])[0];
  const oldIndent = (oldLines[0]!.match(/^[ \t]*/) ?? [''])[0];
  const norms: Array<(s: string) => string> = [
    (s) => s,
    (s) => s.replace(/[ \t]+$/g, ''),
    (s) => s.replace(/^[ \t]+|[ \t]+$/g, ''),
  ];
  for (let i = 0; i < out.length; i += 1) {
    if (context[i]) {
      const mapped = contextOldIndices?.[i];
      if (mapped !== undefined && mapped !== null) out[i] = file[at + mapped]!;
      else {
        while (oldCursor < oldLines.length && norms[tier]!(oldLines[oldCursor]!) !== norms[tier]!(newLines[i]!)) oldCursor += 1;
        if (oldCursor < oldLines.length) {
          out[i] = file[at + oldCursor]!;
          oldCursor += 1;
        }
      }
    } else if (tier === 2 && out[i] !== '' && !/^[ \t]+$/.test(out[i]!) && out[i]!.startsWith(oldIndent)) {
      out[i] = fileIndent + out[i]!.slice(oldIndent.length);
    }
  }
  return out;
}

function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | null = null;
  let after = 0;
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let separator = -1;
    let replace = -1;
    for (let j = searchAt + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        separator = j;
        for (let k = j + 1; k < lines.length; k += 1) {
          if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
            replace = k;
            break;
          }
        }
        break;
      }
    }
    if (separator < 0 || replace < 0) throw new Exit2(`error: parse ${searchAt + 1}`);

    let path: string | null = null;
    for (let j = searchAt - 1; j >= after; j -= 1) {
      const candidate = lines[j]!.trim();
      if (candidate === '' || candidate.startsWith('```')) continue;
      path = candidate;
      break;
    }
    if (path === null) path = previousPath;
    if (path === null) throw new Exit2(`error: parse ${searchAt + 1}`);

    const oldLines = lines.slice(searchAt + 1, separator);
    const newLines = lines.slice(separator + 1, replace);
    const context = newLines.map(() => false);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parsed = fileLines(before);
      const found = matchLines(parsed.lines, oldLines, newLines, context, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length !== 1) throw new Fail('ambiguous', p);
      const at = found.positions[0]!;
      const replacement = replacementLines(parsed.lines, oldLines, newLines, context, found.tier, at);
      const result = [...parsed.lines.slice(0, at), ...replacement, ...parsed.lines.slice(at + oldLines.length)];
      tree.now.set(p, result.length === 0 ? '' : result.join(parsed.br) + (parsed.final ? parsed.br : ''));
    });
    previousPath = path;
    after = replace + 1;
    i = replace + 1;
  }
  return edits;
}

type V4AChunk = {
  anchor: string | null;
  endOfFile: boolean;
  oldLines: string[];
  newLines: string[];
  contextOldIndices: Array<number | null>;
};

type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  }
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i += 1; continue; }
    const line = lines[i]!;
    let section: V4ASection;
    if (line.startsWith('*** Add File: ')) section = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), lines: [] };
    else if (line.startsWith('*** Delete File: ')) section = { kind: 'delete', path: line.slice('*** Delete File: '.length).trim() };
    else if (line.startsWith('*** Update File: ')) section = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), moveTo: null, chunks: [] };
    else throw new Exit2(`error: parse ${i + 1}`);
    const sectionLine = i + 1;
    i += 1;
    const contents: Array<{ line: string; number: number }> = [];
    while (i < last && !lines[i]!.startsWith('*** Add File: ') && !lines[i]!.startsWith('*** Delete File: ') && !lines[i]!.startsWith('*** Update File: ')) {
      contents.push({ line: lines[i]!, number: i + 1 });
      i += 1;
    }
    while (contents.length > 0 && blank(contents[contents.length - 1]!.line)) contents.pop();

    if (section.kind === 'add') {
      for (const entry of contents) {
        if (entry.line !== '' && !entry.line.startsWith('+')) throw new Exit2(`error: parse ${entry.number}`);
        section.lines.push(entry.line === '' ? '' : entry.line.slice(1));
      }
    } else if (section.kind === 'delete') {
      if (contents.length > 0) throw new Exit2(`error: parse ${contents[0]!.number}`);
    } else {
      let at = 0;
      if (contents[0]?.line.startsWith('*** Move to: ')) {
        section.moveTo = contents[0]!.line.slice('*** Move to: '.length).trim();
        at = 1;
      }
      let chunk: V4AChunk | null = null;
      const finishChunk = (): void => {
        if (chunk !== null) {
          section.chunks.push(chunk);
          chunk = null;
        }
      };
      for (; at < contents.length; at += 1) {
        const entry = contents[at]!;
        if (entry.line.startsWith('@@')) {
          finishChunk();
          chunk = { anchor: entry.line.slice(2).trim() || null, endOfFile: false, oldLines: [], newLines: [], contextOldIndices: [] };
        } else if (entry.line === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${entry.number}`);
          chunk.endOfFile = true;
          finishChunk();
        } else if (entry.line === '' || entry.line.startsWith(' ') || entry.line.startsWith('-') || entry.line.startsWith('+')) {
          if (chunk === null) {
            if (section.chunks.length > 0) throw new Exit2(`error: parse ${entry.number}`);
            chunk = { anchor: null, endOfFile: false, oldLines: [], newLines: [], contextOldIndices: [] };
          }
          if (entry.line === '' || entry.line.startsWith(' ')) {
            const value = entry.line === '' ? '' : entry.line.slice(1);
            const oldAt = chunk.oldLines.length;
            chunk.oldLines.push(value);
            chunk.newLines.push(value);
            chunk.contextOldIndices.push(oldAt);
          } else if (entry.line.startsWith('-')) chunk.oldLines.push(entry.line.slice(1));
          else {
            chunk.newLines.push(entry.line.slice(1));
            chunk.contextOldIndices.push(null);
          }
        } else throw new Exit2(`error: parse ${entry.number}`);
      }
      finishChunk();
      if (section.chunks.length === 0 && section.moveTo === null) throw new Exit2(`error: parse ${sectionLine}`);
    }
    sections.push(section);
  }

  return sections.map((section): Edit => (tree) => {
    const paths = section.kind === 'update' && section.moveTo !== null ? [section.path, section.moveTo] : [section.path];
    for (const path of paths) if (!safe(path)) throw new Fail('unsafe', path);
    if (section.kind === 'add') {
      if (tree.get(section.path) !== null) throw new Fail('exists', section.path);
      tree.now.set(section.path, section.lines.length === 0 ? '' : `${section.lines.join('\n')}\n`);
      return;
    }
    if (section.kind === 'delete') {
      if (tree.get(section.path) === null) throw new Fail('missing', section.path);
      tree.now.set(section.path, null);
      return;
    }
    const before = tree.get(section.path);
    if (before === null) throw new Fail('missing', section.path);
    const target = section.moveTo;
    if (target !== null && tree.get(target) !== null) throw new Fail('exists', target);
    const parsed = fileLines(before);
    let current = [...parsed.lines];
    let cursor = 0;
    for (const c of section.chunks) {
      if (c.anchor !== null) {
        let anchorAt = -1;
        const maxTier = strict ? 0 : 2;
        const norms: Array<(s: string) => string> = [
          (s) => s,
          (s) => s.replace(/[ \t]+$/g, ''),
          (s) => s.replace(/^[ \t]+|[ \t]+$/g, ''),
        ];
        for (let tier = 0; tier <= maxTier && anchorAt < 0; tier += 1) {
          for (let k = cursor; k < current.length; k += 1) {
            if (norms[tier]!(current[k]!) === norms[tier]!(c.anchor)) { anchorAt = k; break; }
          }
        }
        if (anchorAt < 0) throw new Fail('no-match', section.path);
        cursor = anchorAt + 1;
      }
      let at = cursor;
      let tier = 0;
      if (c.oldLines.length > 0) {
        const found = matchLines(current, c.oldLines, c.newLines, c.contextOldIndices.map((x) => x !== null), strict);
        const valid: number[] = [];
        if (found !== null) {
          tier = found.tier;
          for (const position of found.positions) {
            if (position < cursor) continue;
            if (c.endOfFile && position + c.oldLines.length !== current.length) continue;
            valid.push(position);
          }
        }
        // Search tiers with the cursor and EOF constraints applied, rather than allowing an earlier
        // unconstrained occurrence to hide a valid occurrence at a later tier.
        if (valid.length === 0) {
          const norms: Array<(s: string) => string> = [
            (s) => s,
            (s) => s.replace(/[ \t]+$/g, ''),
            (s) => s.replace(/^[ \t]+|[ \t]+$/g, ''),
          ];
          let match: { at: number; tier: number } | null = null;
          for (let t = 0; t <= (strict ? 0 : 2) && match === null; t += 1) {
            for (let position = cursor; position + c.oldLines.length <= current.length; position += 1) {
              if (c.endOfFile && position + c.oldLines.length !== current.length) continue;
              if (c.oldLines.every((old, j) => norms[t]!(current[position + j]!) === norms[t]!(old))) { match = { at: position, tier: t }; break; }
            }
          }
          if (match === null) throw new Fail('no-match', section.path);
          at = match.at;
          tier = match.tier;
        } else at = valid[0]!;
      } else if (c.endOfFile) at = current.length;

      const replacement = [...c.newLines];
      const fileIndent = c.oldLines.length > 0 ? (current[at]!.match(/^[ \t]*/) ?? [''])[0] : '';
      const oldIndent = c.oldLines.length > 0 ? (c.oldLines[0]!.match(/^[ \t]*/) ?? [''])[0] : '';
      for (let j = 0; j < replacement.length; j += 1) {
        const oldAt = c.contextOldIndices[j];
        if (oldAt !== null && oldAt !== undefined) replacement[j] = current[at + oldAt]!;
        else if (tier === 2 && replacement[j] !== '' && !/^[ \t]+$/.test(replacement[j]!) && replacement[j]!.startsWith(oldIndent)) {
          replacement[j] = fileIndent + replacement[j]!.slice(oldIndent.length);
        }
      }
      current = [...current.slice(0, at), ...replacement, ...current.slice(at + c.oldLines.length)];
      cursor = at + replacement.length;
    }
    const result = current.length === 0 ? '' : current.join(parsed.br) + (parsed.final ? parsed.br : '');
    if (target !== null) {
      tree.now.set(section.path, null);
      tree.now.set(target, result);
      tree.moves.push({ oldPath: section.path, newPath: target });
    } else tree.now.set(section.path, result);
  });
}

type Hunk = { a: number; oldLines: string[]; newLines: string[]; addedLines: string[]; context: boolean[]; contextOldIndices: Array<number | null>; noFinalBreak: boolean; lastPlusNoFinalBreak: boolean | null };
type UnifiedSection = {
  diffPaths: [string, string] | null;
  oldPath: string | null;
  newPath: string | null;
  pair: boolean;
  newMode: boolean;
  deletedMode: boolean;
  hunks: Hunk[];
  startedHunk: boolean;
};

function stripDiffPrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function unifiedPath(line: string, prefixLength: number): string {
  const raw = line.slice(prefixLength).split('\t', 1)[0]!.trim();
  return raw === '/dev/null' ? raw : stripDiffPrefix(raw);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  const start = (diffPaths: [string, string] | null, oldPath: string | null, newPath: string | null): UnifiedSection => {
    const s: UnifiedSection = { diffPaths, oldPath, newPath, pair: oldPath !== null, newMode: false, deletedMode: false, hunks: [], startedHunk: false };
    sections.push(s);
    current = s;
    return s;
  };
  const isPair = (i: number): boolean => lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.*?) b\/(.*?)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      start([m[1]!, m[2]!], null, null);
      i += 1;
      continue;
    }
    if (isPair(i)) {
      if (current !== null && !current.startedHunk && current.diffPaths !== null && !current.pair) {
        current.oldPath = unifiedPath(line, 4);
        current.newPath = unifiedPath(lines[i + 1]!, 4);
        current.pair = true;
      } else {
        start(null, unifiedPath(line, 4), unifiedPath(lines[i + 1]!, 4));
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@(?:.*)$/.exec(line);
      if (!m || current === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      current.startedHunk = true;
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        if (lines[i]!.startsWith('diff --git') || isPair(i)) break;
        const b = lines[i]!;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const oldLines: string[] = [];
      const newLines: string[] = [];
      const addedLines: string[] = [];
      const context: boolean[] = [];
      const contextOldIndices: Array<number | null> = [];
      const noNewlineAfter = new Set<number>();
      const plusBodyIndices: number[] = [];
      for (let j = 0; j < body.length; j += 1) {
        const b = body[j]!;
        if (b.startsWith('\\')) {
          if (j > 0) noNewlineAfter.add(j - 1);
        } else if (b.startsWith(' ')) {
          const value = b.slice(1);
          const oldAt = oldLines.length;
          oldLines.push(value);
          newLines.push(value);
          context.push(true);
          contextOldIndices.push(oldAt);
        } else if (b.startsWith('-')) oldLines.push(b.slice(1));
        else if (b.startsWith('+')) {
          const value = b.slice(1);
          newLines.push(value);
          addedLines.push(value);
          context.push(false);
          contextOldIndices.push(null);
          plusBodyIndices.push(j);
        } else { // Empty body line is an empty context line.
          const oldAt = oldLines.length;
          oldLines.push('');
          newLines.push('');
          context.push(true);
          contextOldIndices.push(oldAt);
        }
      }
      const lastResultBodyIndex = (() => {
        let seen = -1;
        for (let j = 0; j < body.length; j += 1) {
          const b = body[j]!;
          if (b.startsWith('\\')) continue;
          if (b.startsWith(' ') || b.startsWith('+') || b === '') seen = j;
        }
        return seen;
      })();
      const lastPlus = plusBodyIndices.length === 0 ? null : plusBodyIndices[plusBodyIndices.length - 1]!;
      current.hunks.push({ a, oldLines, newLines, addedLines, context, contextOldIndices, noFinalBreak: lastResultBodyIndex >= 0 && noNewlineAfter.has(lastResultBodyIndex), lastPlusNoFinalBreak: lastPlus === null ? null : noNewlineAfter.has(lastPlus) });
      continue;
    }
    if (current !== null && !current.startedHunk && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (current !== null && !current.startedHunk) {
      if (line.startsWith('rename from ')) current.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) current.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode ')) current.newMode = true;
      else if (line.startsWith('deleted file mode ')) current.deletedMode = true;
    }
    i += 1;
  }

  return sections.map((section): Edit => (tree) => {
    let oldPath = section.oldPath;
    let newPath = section.newPath;
    if (section.pair) {
      // The explicit file pair, including /dev/null, wins over rename and diff header paths.
    } else if (oldPath !== null || newPath !== null) {
      // Rename names are a complete pair; a missing endpoint is filled by the diff header.
      if (section.diffPaths !== null) {
        oldPath ??= section.diffPaths[0];
        newPath ??= section.diffPaths[1];
      }
    } else if (section.diffPaths !== null) {
      oldPath = section.diffPaths[0];
      newPath = section.diffPaths[1];
    }
    let creation = oldPath === '/dev/null' || section.newMode;
    let deletion = newPath === '/dev/null' || section.deletedMode;
    if (creation) oldPath = null;
    if (deletion) newPath = null;
    const move = !creation && !deletion && oldPath !== null && newPath !== null && oldPath !== newPath;
    const source = creation ? null : oldPath;
    const destination = deletion ? null : newPath;
    // Check every path this edit operates on before any existence or content check.
    if (source !== null && !safe(source)) throw new Fail('unsafe', source);
    if (destination !== null && !safe(destination)) throw new Fail('unsafe', destination);
    if (creation) {
      const p = destination ?? newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const created: string[] = [];
      let noFinal = false;
      for (const h of section.hunks) {
        for (let j = 0; j < h.addedLines.length; j += 1) created.push(h.addedLines[j]!);
        const plusBody = h.lastPlusNoFinalBreak;
        if (plusBody !== null) noFinal = plusBody;
      }
      tree.now.set(p, created.length === 0 ? '' : created.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = source ?? oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = source ?? '';
    const target = destination ?? p;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (move && !safe(target)) throw new Fail('unsafe', target);
    if (tree.get(p) === null) throw new Fail('missing', p);
    if (move && tree.get(target) !== null) throw new Fail('exists', target);
    const before = tree.get(p)!;
    const parsed = fileLines(before);
    let currentLines = [...parsed.lines];
    let final = parsed.final;
    let d = 0;
    for (const h of section.hunks) {
      const found = matchLines(currentLines, h.oldLines, h.newLines, h.context, strict);
      let at: number;
      let tier = 0;
      if (h.oldLines.length === 0) {
        at = Math.max(0, Math.min(currentLines.length, h.a + d));
      } else {
        if (found === null) throw new Fail('no-match', p);
        tier = found.tier;
        const expected = h.a - 1 + d;
        at = found.positions.reduce((best, pos) => Math.abs(pos - expected) < Math.abs(best - expected) || (Math.abs(pos - expected) === Math.abs(best - expected) && pos < best) ? pos : best);
      }
      const replacement = h.oldLines.length === 0 ? h.newLines : replacementLines(currentLines, h.oldLines, h.newLines, h.context, tier, at, h.contextOldIndices);
      const endsAtEof = h.oldLines.length === 0 ? at === currentLines.length : at + h.oldLines.length === currentLines.length;
      currentLines = [...currentLines.slice(0, at), ...replacement, ...currentLines.slice(at + h.oldLines.length)];
      if (endsAtEof) final = !h.noFinalBreak;
      d += h.newLines.length - h.oldLines.length;
    }
    const result = currentLines.length === 0 ? '' : currentLines.join(parsed.br) + (final ? parsed.br : '');
    if (move) {
      tree.now.set(p, null);
      tree.now.set(target, result);
      tree.moves.push({ oldPath: p, newPath: target });
    } else tree.now.set(p, result);
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'v4a' ? v4aEdits(lines, strict) : [];
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
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const moveRows: Array<{ key: string; line: string; paths: string[] }> = [];
  for (const move of tree.moves) {
    const oldState = changed.get(move.oldPath);
    const newState = changed.get(move.newPath);
    if (tree.original(move.oldPath) !== null && tree.get(move.oldPath) === null
      && tree.original(move.newPath) === null && tree.get(move.newPath) !== null
      && oldState?.now === null && oldState.was !== null && newState?.was === null && newState.now !== null) {
      moveRows.push({ key: move.newPath, line: `R ${move.oldPath} -> ${move.newPath}`, paths: [move.oldPath, move.newPath] });
      changed.delete(move.oldPath);
      changed.delete(move.newPath);
    }
  }
  const outputRows: Array<{ key: string; line: string; paths: string[] }> = [...moveRows];
  for (const [p, state] of changed) {
    const kind = state.was === null ? 'A' : state.now === null ? 'D' : 'M';
    outputRows.push({ key: p, line: `${kind} ${p}`, paths: [p] });
  }
  outputRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  for (const row of outputRows) {
    if (check) continue;
    for (const p of row.paths) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = outputRows.map((row) => row.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
