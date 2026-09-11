/* ================================================================
   tools/harness/extract.mjs — borrow real app code, don't copy it
   The main-thread files (js/panel-controls.js, js/svg-export.js) are
   plain global-scope browser scripts: they can't be imported, and
   loading them whole needs a full DOM (they attach listeners and build
   markup at load time). But the few pieces the harness actually needs
   — gatherSettings, computePaperLayout, the Contour chaining/merge
   functions — are pure, self-contained declarations inside those files.
   So instead of duplicating them here (which would silently drift the
   moment anyone edits the real app), this pulls their SOURCE TEXT out
   by name and evaluates it in a sandbox the caller populates with
   whatever globals those declarations reference ($, vp, layerStyle, …).
   If a declaration is renamed or deleted in the app, extraction throws
   loudly rather than the harness quietly testing stale logic.
   ================================================================ */
import { readFileSync } from 'node:fs';

/* Finds `function NAME(…){…}` / `const NAME = …;` at column 0 (top-level
   only — nested helpers inside another function are never matched, since
   they're indented) and returns the declaration's full source text,
   brace/paren-balanced. Deliberately a simple scanner, not a parser: the
   two files it reads are ordinary, consistently-formatted ES5-ish source
   with top-level declarations always starting at column 0. */
function findDecl(src, name){
  const patterns = [
    new RegExp('^function\\s+' + name + '\\s*\\(', 'm'),
    new RegExp('^const\\s+' + name + '\\s*=', 'm'),
    new RegExp('^let\\s+' + name + '\\s*=', 'm'),
  ];
  for (const re of patterns){
    const m = re.exec(src);
    if (!m) continue;
    const start = m.index;
    // Walk forward tracking depth + string/comment state; a function ends at
    // its matching '}', a const/let at the ';' (or newline) at depth 0.
    const isFn = src.startsWith('function', start);
    let i = start, depth = 0, seenOpen = false;
    let inStr = null, inLine = false, inBlock = false;
    for (; i < src.length; i++){
      const c = src[i], c2 = src[i+1];
      if (inLine){ if (c === '\n') inLine = false; continue; }
      if (inBlock){ if (c === '*' && c2 === '/'){ inBlock = false; i++; } continue; }
      if (inStr){
        if (c === '\\'){ i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '/' && c2 === '/'){ inLine = true; i++; continue; }
      if (c === '/' && c2 === '*'){ inBlock = true; i++; continue; }
      if (c === '"' || c === "'" || c === '`'){ inStr = c; continue; }
      if (c === '{' || c === '(' || c === '['){ depth++; if (c === '{') seenOpen = true; continue; }
      if (c === '}' || c === ')' || c === ']'){
        depth--;
        if (isFn && seenOpen && depth === 0) return src.slice(start, i+1);
        continue;
      }
      if (!isFn && depth === 0 && (c === ';' || c === '\n')) return src.slice(start, i+1);
    }
    throw new Error('extract: unbalanced declaration for ' + name);
  }
  throw new Error('extract: no top-level declaration named "' + name + '" — ' +
    'it was probably renamed or removed in the app; update the harness to match.');
}

/* Pulls `names` out of `file` (repo-relative) and returns one source blob
   with each declaration in the order given. */
export function extractFrom(file, names){
  const src = readFileSync(file, 'utf8');
  return names.map(n => findDecl(src, n)).join('\n\n');
}

/* Evaluates extracted source with `env` as its surrounding scope, and
   returns the named declarations as an object. Implemented as one Function
   whose parameters are the env keys — so the extracted code sees them as
   ordinary identifiers, exactly as it would as globals in the browser. */
export function evalWithEnv(code, env, exportNames){
  const keys = Object.keys(env);
  const body = '"use strict";\n' + code + '\nreturn {' + exportNames.join(', ') + '};';
  return new Function(...keys, body)(...keys.map(k => env[k]));
}
