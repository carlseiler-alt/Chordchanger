/* ChordShift – chord transposition + OCR glue. Plain ES5-style JS for old Safari (iOS 15). */
(function () {
  'use strict';
  var VERSION = '1.3.1', BUILD_DATE = '12 Nov 2026';

  /* ---------- Music theory ---------- */
  var SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  var FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];
  var LETTER = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  var MAJOR_FLAT_KEYS = [1, 3, 5, 8, 10];   // Db Eb F Ab Bb
  var MINOR_FLAT_KEYS = [0, 2, 5, 7, 10];   // Cm Dm Fm Gm Bbm

  var CHORD_RE = /^([A-G][#b]?)((?:maj|min|dim|aug|sus|add|alt|m|M|\u00b0|\u00f8|\+|-|\d+|[#b]|\(|\)|,|\.)*)(?:\/([A-G][#b]?))?$/;
  var IGNORE_RE = /^(?:\/|%|-|\u2013|\u2014|x\d+|\d+x|\(x\d+\)|N\.?C\.?|\.{2,}|\u2026)$/i;

  function pcOf(name) {
    var n = LETTER[name.charAt(0)];
    if (name.charAt(1) === '#') n += 1;
    else if (name.charAt(1) === 'b') n -= 1;
    return (n + 12) % 12;
  }

  function parseChord(tok) {
    var m = CHORD_RE.exec(tok);
    if (!m) return null;
    return { root: m[1], qual: m[2] || '', bass: m[3] || '' };
  }

  function isMinor(qual) {
    return /^(m(?!aj)|min)/.test(qual);
  }

  function spell(pc, flats) { return (flats ? FLAT : SHARP)[((pc % 12) + 12) % 12]; }

  function shiftChord(c, shift, flats) {
    if (c.pair) return shiftChord(c.pair[0], shift, flats) + ' ' + shiftChord(c.pair[1], shift, flats);
    if (shift === 0) return c.root + c.qual + (c.bass ? '/' + c.bass : '');
    var out = spell(pcOf(c.root) + shift, flats) + c.qual;
    if (c.bass) out += '/' + spell(pcOf(c.bass) + shift, flats);
    return out;
  }

  /* Normalise symbols that OCR / notation often produce. */
  function normalise(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/\u266f/g, '#')
      .replace(/\u266d/g, 'b')
      .replace(/\u266e/g, '')
      .replace(/\u00a0/g, ' ');
  }

  /* Split a token into leading bar chars, core, trailing bar chars. */
  function splitToken(tok) {
    var m = /^([|:]*)(.*?)([|:]*)$/.exec(tok);
    return { pre: m[1], core: m[2], post: m[3] };
  }

  function tokenize(line) {
    var re = /:?\|+:?|[^\s|]+/g, m, out = [];
    while ((m = re.exec(line)) !== null) out.push({ text: m[0], index: m.index });
    return out;
  }

  /* ---- Tolerant token handling: OCR slips, dirt, numbered alternatives ---- */
  var ROOT_RE = /^[A-G][#b]?$/;
  var MARK_RE = /^\(?\d{1,2}[.):\]]?\)?$/;                         // 1)  2.  (1)  2
  var NOISE_ONLY = /^[^\sA-Za-z0-9\u00c0-\u024f|\/%+\-\u2013\u2014:()\[]+$/;  // specks of dirt
  var NOISE_EDGE = /^[;,.'`"~_^*\u2018\u2019\u201c\u201d\u00b7\u2022]+|[;,.'`"~_^*\u2018\u2019\u201c\u201d\u00b7\u2022]+$/g;

  /* Is `bassPc` a plausible bass note for chord l? (C/G yes, C/D no: that is two chords, "C D") */
  function bassFits(l, bassPc) {
    var iv = ((bassPc - pcOf(l.root)) % 12 + 12) % 12, q = l.qual, t = [0, 7];
    if (isMinor(q) || /^dim|\u00b0/.test(q)) t.push(3); else if (/^sus/.test(q)) t.push(5, 2); else t.push(4);
    if (/^dim|\u00b0/.test(q)) t.push(6);
    if (/^aug|\+/.test(q)) t.push(8);
    if (/7|9|11|13/.test(q)) t.push(10, 11);
    if (/9|add9|2/.test(q)) t.push(2);
    if (/11|add11|4/.test(q)) t.push(5);
    if (/6|13/.test(q)) t.push(9);
    return iv !== 0 && t.indexOf(iv) !== -1;
  }

  function trySlash(t) {
    var i, l, r, hasSep;
    for (i = 1; i < t.length; i++) {
      l = parseChord(t.slice(0, i));
      if (!l || l.bass) continue;
      r = t.slice(i); hasSep = false;
      if (r.length > 1 && /^[lI1|!\\]/.test(r) && ROOT_RE.test(r.slice(1))) { r = r.slice(1); hasSep = true; }  // slash read as a letter
      if (!ROOT_RE.test(r)) continue;
      if (hasSep || bassFits(l, pcOf(r))) return { root: l.root, qual: l.qual, bass: r };                       // "CG" -> C/G
      return { pair: [l, { root: r, qual: '', bass: '' }] };                                                     // "CD" -> C D
    }
    return null;
  }

  function resolveChord(core) {
    var stripped = core.replace(NOISE_EDGE, '');
    var mapped = stripped.replace(/[\u20ac\u00a2\u00a9]/g, 'C').replace(/[\u0161\u017e]/g, '#').replace(/rn/g, 'm').replace(/\/6$/, '/G').replace(/\/8$/, '/B');
    if (/^[ACDEFG][a-g]$/.test(stripped) && stripped.charAt(1) === stripped.charAt(0).toLowerCase()) mapped = stripped.charAt(0);   // "Cc" -> C
    if (/^\[[^\]]{0,2}$/.test(stripped)) mapped = 'C';                                                                              // bold C read as "[" / "[of" / "[4"
    var cands = [stripped, mapped, core], i, c;
    for (i = 0; i < cands.length; i++) { c = parseChord(cands[i]); if (c) return c; }
    for (i = 0; i < 2; i++) { c = trySlash(cands[i]); if (c) return c; }
    return null;
  }

  /* kind: 'chord' | 'skip' (kept as is) | 'noise' (dropped) | null (not part of a chord line) */
  function classify(tok) {
    var p = splitToken(tok), core = p.core, c;
    if (core === '') return tok.indexOf('|') >= 0 ? { kind: 'skip', text: tok } : { kind: 'noise' };   // bar lines stay, loose ":" goes
    if (/^\d{1,2}$/.test(core)) return { kind: 'noise' };                      // loose digit from the page margin
    if (IGNORE_RE.test(core) || MARK_RE.test(core)) return { kind: 'skip', text: tok };
    var pm = /^\(([^()]+)\)$/.exec(core), open = '', close = '';
    if (pm) { core = pm[1]; open = '('; close = ')'; }
    c = resolveChord(core);
    if (!c && NOISE_ONLY.test(core)) return { kind: 'noise' };
    // ":" only means something next to a bar line (repeat signs), otherwise it is dirt
    return c ? { kind: 'chord', chord: c, pre: (p.pre.indexOf('|') >= 0 ? p.pre : '') + open, post: close + (p.post.indexOf('|') >= 0 ? p.post : '') } : null;
  }

  /* Decide whether a line is a chord line and what to do with each token. */
  function analyse(line) {
    var toks = tokenize(line), kinds = [], chords = 0, unknown = 0, i, k, t;
    if (!toks.length) return null;
    for (i = 0; i < toks.length; i++) {
      t = toks[i].text; k = classify(t);
      if (k) { if (k.kind === 'chord') chords++; }
      else if (t.length <= 3) {          // short leftovers: lowercase = dirt read as letters, otherwise a damaged chord
        unknown++;
        k = (/^[a-z]+$/.test(t) || t.length === 1) ? { kind: 'noise' } : { kind: 'skip', text: t };
      } else return null;
      kinds.push(k);
    }
    if (!chords) return null;
    if (unknown && !(chords >= 2 && unknown <= Math.floor((chords + unknown) * 0.25))) return null;
    return { toks: toks, kinds: kinds };
  }

  function isChordLine(line) { return !!analyse(line); }

  function keyOf(c) {
    var minor = isMinor(c.qual);
    return { pc: pcOf(c.root), minor: minor, name: c.root + (minor ? 'm' : '') };
  }

  function findKey(text) {
    var lines = normalise(text).split('\n'), i, j, c, an;
    for (i = 0; i < lines.length; i++) {
      if (/\[[^\]]+\]/.test(lines[i])) {
        var br = /\[([^\]]+)\]/g, m;
        while ((m = br.exec(lines[i])) !== null) {
          c = resolveChord(m[1].trim());
          if (c) return keyOf(c);
        }
      } else if ((an = analyse(lines[i]))) {
        for (j = 0; j < an.kinds.length; j++) {
          if (an.kinds[j].kind === 'chord') return keyOf(an.kinds[j].chord);
        }
      }
    }
    return null;
  }

  function usesFlatsOnly(text) {
    var hasFlat = /(^|[\s\[|\/])[A-G]b/m.test(text), hasSharp = /(^|[\s\[|\/])[A-G]#/m.test(text);
    return hasFlat && !hasSharp;
  }

  function chooseFlats(mode, key, shift, text) {
    if (mode === 'flats') return true;
    if (mode === 'sharps') return false;
    if (!key) return usesFlatsOnly(text);
    var target = ((key.pc + shift) % 12 + 12) % 12;
    var list = key.minor ? MINOR_FLAT_KEYS : MAJOR_FLAT_KEYS;
    return list.indexOf(target) !== -1;
  }

  /* A line that was not transposed but contains several chord-like words: probably a damaged chord line. */
  function looksLikeChords(line) {
    if (/\[[^\]]+\]/.test(line)) return false;
    var toks = tokenize(line), n = 0, i, k;
    for (i = 0; i < toks.length; i++) { k = classify(toks[i].text); if (k && k.kind === 'chord') n++; }
    return n >= 2;
  }

  function transposeLine(line, shift, flats, stats) {
    if (/\[[^\]]+\]/.test(line)) {
      var did = false;
      var res = line.replace(/\[([^\]]+)\]/g, function (all, inner) {
        var c = resolveChord(inner.trim());
        if (!c) return all;
        did = true; stats.count++;
        return '[' + shiftChord(c, shift, flats) + ']';
      });
      return { text: res, chordLine: did };
    }
    var an = analyse(line);
    if (!an) return { text: line, chordLine: false };

    var toks = an.toks, out = '', i, k, rep, col, adjacent;
    for (i = 0; i < toks.length; i++) {
      k = an.kinds[i];
      if (k.kind === 'noise') continue;
      if (k.kind === 'chord') { rep = k.pre + shiftChord(k.chord, shift, flats) + k.post; stats.count++; }
      else rep = k.text;
      col = toks[i].index;
      adjacent = i > 0 && col === toks[i - 1].index + toks[i - 1].text.length;
      if (out.length < col) out += new Array(col - out.length + 1).join(' ');
      else if (out.length > 0 && !adjacent) out += ' ';
      out += rep;
    }
    return { text: out, chordLine: true };
  }

  function transposeText(text, shift, mode) {
    text = normalise(text);
    var key = findKey(text), flats = chooseFlats(mode, key, shift, text);
    var stats = { count: 0 }, lines = text.split('\n'), res = [], i, r;
    for (i = 0; i < lines.length; i++) {
      r = transposeLine(lines[i], shift, flats, stats);
      res.push({ text: r.text.replace(/\s+$/, ''), chordLine: r.chordLine, suspect: !r.chordLine && looksLikeChords(lines[i]) });
    }
    return {
      lines: res, count: stats.count, key: key,
      newKey: key ? spell(key.pc + shift, flats) + (key.minor ? 'm' : '') : null
    };
  }

  /* ---------- Rebuild layout from OCR word boxes ---------- */
  function median(a) {
    if (!a.length) return 0;
    a = a.slice().sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  }

  function repairLine(line) {
    return isChordLine(line) ? transposeLine(line, 0, false, { count: 0 }).text : line;
  }

  /* OCR often returns "CF" for C/F (slash swallowed) or for two close chords "C F". The letter boxes tell:
     touching/overlapping boxes mean a slash was there, a visible gap means two chords. */
  function splitMerged(text, symbols) {
    if (!symbols || symbols.length !== text.length || parseChord(text)) return text;
    var i, l, gap;
    for (i = 1; i < text.length; i++) {
      l = parseChord(text.slice(0, i));
      if (l && !l.bass && ROOT_RE.test(text.slice(i))) {
        gap = symbols[i].bbox.x0 - symbols[i - 1].bbox.x1;
        return text.slice(0, i) + (gap <= 2 ? '/' : ' ') + text.slice(i);
      }
    }
    return text;
  }

  /* Find an empty vertical band (a gutter) between two text columns, in OCR word coordinates. */
  function findGutter(words) {
    if (words.length < 30) return null;
    var minX = Infinity, maxX = -Infinity, i, b, k;
    for (i = 0; i < words.length; i++) { if (words[i].x0 < minX) minX = words[i].x0; if (words[i].x1 > maxX) maxX = words[i].x1; }
    var W = maxX - minX; if (W < 300) return null;
    var N = 200, cover = new Array(N), step = W / N, allow = Math.max(2, Math.round(words.length * 0.025));
    for (b = 0; b < N; b++) cover[b] = 0;
    for (i = 0; i < words.length; i++) {
      for (b = Math.floor((words[i].x0 - minX) / step); b <= Math.min(N - 1, Math.floor((words[i].x1 - minX) / step)); b++) cover[b]++;
    }
    var best = null, run = 0, start = 0;
    for (b = Math.floor(N * 0.28); b < Math.ceil(N * 0.72); b++) {
      if (cover[b] <= allow) { if (!run) start = b; run++; if (!best || run > best.len) best = { from: start, len: run }; }
      else run = 0;
    }
    if (!best || best.len < N * 0.035) return null;
    var cut = minX + (best.from + best.len / 2) * step, left = 0, right = 0;
    for (k = 0; k < words.length; k++) { if ((words[k].x0 + words[k].x1) / 2 < cut) left++; else right++; }
    if (left < words.length * 0.2 || right < words.length * 0.2) return null;
    // A real second column starts every line at the same left edge; scattered chords do not.
    var firstX = {}, k2, lineIds = [], vals = [], edge, aligned = 0;
    for (k2 = 0; k2 < words.length; k2++) {
      if ((words[k2].x0 + words[k2].x1) / 2 < cut) continue;
      if (firstX[words[k2].line] === undefined || words[k2].x0 < firstX[words[k2].line]) firstX[words[k2].line] = words[k2].x0;
    }
    for (k2 in firstX) { vals.push(firstX[k2]); }
    if (vals.length < 6) return null;
    vals.sort(function (p, q) { return p - q; });
    edge = vals[Math.floor(vals.length * 0.1)];
    for (k2 = 0; k2 < vals.length; k2++) if (vals[k2] - edge <= W * 0.02) aligned++;
    if (aligned < 6 || aligned < vals.length * 0.5) return null;
    return cut;
  }

  function buildColumn(rows, charW, lineH) {
    // rows: [{ words: [{text,x0,x1}], y0, y1 }] already in reading order
    var starts = [], i, j, minX, out = [], prev = null, row, col, wd;
    for (i = 0; i < rows.length; i++) if (rows[i].words.length) starts.push(rows[i].words[0].x0);
    if (!starts.length) return '';
    starts.sort(function (x, y) { return x - y; });
    minX = starts[Math.floor(starts.length * 0.1)];          // ignore stray marks at the page edge
    for (i = 0; i < rows.length; i++) {
      if (!rows[i].words.length) continue;
      if (prev && (rows[i].y0 - prev.y1) > lineH * 1.6) out.push('');
      row = '';
      for (j = 0; j < rows[i].words.length; j++) {
        wd = rows[i].words[j];
        col = Math.max(0, Math.round((wd.x0 - minX) / charW));
        if (row.length < col) row += new Array(col - row.length + 1).join(' ');
        else if (row.length > 0) row += ' ';
        row += wd.text;
      }
      if (/^[^A-Za-z0-9\u00c0-\u024f|]*$/.test(row)) continue;   // only dirt
      out.push(repairLine(row));
      prev = rows[i];
    }
    return out.join('\n');
  }

  function rebuildText(data, opts) {
    var lines = data && data.lines;
    if (!lines || !lines.length) return (data && data.text) || '';
    var words = [], widths = [], heights = [], i, j, L, w, wd;
    for (i = 0; i < lines.length; i++) {
      L = lines[i];
      if (L.bbox) heights.push(L.bbox.y1 - L.bbox.y0);
      for (j = 0; j < (L.words || []).length; j++) {
        w = L.words[j]; if (!w.text.trim()) continue;
        if (/^[<>~_^*=;:\\`\u2022\u00b7]+$/.test(w.text.trim())) continue;   // lone symbol = dirt on the page
        wd = { text: splitMerged(w.text.trim(), w.symbols), x0: w.bbox.x0, x1: w.bbox.x1, line: i };
        words.push(wd);
        if (w.text.length >= 2) widths.push((w.bbox.x1 - w.bbox.x0) / w.text.length);
      }
    }
    // Grid cell width: lyrics are in a proportional font, so size the grid from the narrow end of the lyric
    // letters. A wider cell makes lyric words overflow and get pushed right, away from the chords above them.
    var lyr = [], q;
    for (i = 0; i < words.length; i++) {
      if (/[A-Za-z\u00c0-\u024f]{4}/.test(words[i].text) && !parseChord(words[i].text)) lyr.push((words[i].x1 - words[i].x0) / words[i].text.length);
    }
    lyr.sort(function (p, r) { return p - r; });
    q = lyr.length >= 6 ? lyr[Math.floor(lyr.length * 0.1)] : 0;
    var charW = q || median(widths) || 10, lineH = median(heights) || 30;
    var cut = (!opts || opts.columns !== false) ? findGutter(words) : null;
    function rowsFor(pick) {
      var rows = [], k, ws;
      for (k = 0; k < lines.length; k++) {
        if (!lines[k].bbox) continue;
        ws = words.filter(function (x) { return x.line === k && pick(x); });
        if (ws.length) rows.push({ words: ws, y0: lines[k].bbox.y0, y1: lines[k].bbox.y1 });
      }
      return rows;
    }
    if (cut === null) return buildColumn(rowsFor(function () { return true; }), charW, lineH);
    var a = buildColumn(rowsFor(function (x) { return (x.x0 + x.x1) / 2 < cut; }), charW, lineH);
    var b = buildColumn(rowsFor(function (x) { return (x.x0 + x.x1) / 2 >= cut; }), charW, lineH);
    return a + '\n\n' + b;
  }

  /* ---------- Image preparation ---------- */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    });
  }

  /* Estimate how tall the text lines are (px, in the original image) from rows that contain ink. */
  function estimateTextHeight(img) {
    var w = img.naturalWidth, h = img.naturalHeight, s0 = Math.min(1, 2400 / Math.max(w, h));
    var cw = Math.max(32, Math.round(w * s0)), ch = Math.max(32, Math.round(h * s0));
    var c0 = document.createElement('canvas'); c0.width = cw; c0.height = ch;
    var x0 = c0.getContext('2d'); x0.drawImage(img, 0, 0, cw, ch);
    var sm = document.createElement('canvas'); sm.width = Math.max(2, cw >> 4); sm.height = Math.max(2, ch >> 4);
    sm.getContext('2d').drawImage(c0, 0, 0, sm.width, sm.height);
    var bgc = document.createElement('canvas'); bgc.width = cw; bgc.height = ch;
    var bx = bgc.getContext('2d'); bx.imageSmoothingEnabled = true; bx.drawImage(sm, 0, 0, cw, ch);
    var a = x0.getImageData(0, 0, cw, ch).data, b = bx.getImageData(0, 0, cw, ch).data;
    var rows = new Array(ch), x, y, i, ga, gb, med, sample = [];
    for (i = 0; i < b.length; i += 4 * 97) sample.push(b[i + 1]);
    sample.sort(function (p, q) { return p - q; });
    med = sample[sample.length >> 1] || 200;
    var thr = Math.max(25, 0.25 * med), need = Math.max(3, 0.004 * cw);
    for (y = 0; y < ch; y++) {
      var n = 0;
      for (x = 0; x < cw; x++) {
        i = (y * cw + x) * 4;
        ga = (a[i] * 299 + a[i + 1] * 587 + a[i + 2] * 114) / 1000; gb = (b[i] * 299 + b[i + 1] * 587 + b[i + 2] * 114) / 1000;
        if (gb - ga > thr) n++;
      }
      rows[y] = n;
    }
    var bands = [], start = -1;
    for (y = 0; y <= ch; y++) {
      if (y < ch && rows[y] > need) { if (start < 0) start = y; }
      else if (start >= 0) { if (y - start >= 3) bands.push(y - start); start = -1; }
    }
    if (bands.length < 3) return 0;
    bands.sort(function (p, q) { return p - q; });
    return bands[bands.length >> 1] / s0;
  }

  /* Scale so text lines are about 36px tall: the size Tesseract reads best. */
  var TARGET_H = 36;
  function chooseScale(img) {
    var w = img.naturalWidth, h = img.naturalHeight, H = 0, f;
    try { H = estimateTextHeight(img); } catch (e) { H = 0; }
    if (H >= 5) f = (H >= TARGET_H * 0.78 && H <= TARGET_H * 1.28) ? 1 : TARGET_H / H;
    else f = Math.max(h, w) < 1000 ? 1.6 : Math.min(1, 2600 / Math.max(w, h));
    f = Math.max(0.35, Math.min(2.6, f));
    while (f > 0.35 && (w * f * h * f > 9e6 || Math.max(w, h) * f > 4200)) f -= 0.05;
    return f;
  }

  function prepare(img, boost) {
    var w = img.naturalWidth, h = img.naturalHeight, s = chooseScale(img);
    var cw = Math.round(w * s), ch = Math.round(h * s);
    var cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    if (boost) {
      var d = ctx.getImageData(0, 0, cw, ch), p = d.data, i, g, lo = 255, hi = 0, hist = new Array(256), k;
      for (k = 0; k < 256; k++) hist[k] = 0;
      for (i = 0; i < p.length; i += 4) {
        g = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0;
        p[i] = g; hist[g]++;
      }
      var total = cw * ch, acc = 0;
      for (k = 0; k < 256; k++) { acc += hist[k]; if (acc > total * 0.01) { lo = k; break; } }
      acc = 0;
      for (k = 255; k >= 0; k--) { acc += hist[k]; if (acc > total * 0.2) { hi = k; break; } }
      if (hi - lo < 40) { lo = 0; hi = 255; }
      var range = hi - lo;
      for (i = 0; i < p.length; i += 4) {
        g = (p[i] - lo) * 255 / range;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        p[i] = p[i + 1] = p[i + 2] = g; p[i + 3] = 255;
      }
      ctx.putImageData(d, 0, 0);
    }
    return cv;
  }

  /* ---------- UI ---------- */
  var $ = function (id) { return document.getElementById(id); };
  var shift = 0, mode = 'auto', worker = null, last = null, imgUrl = null, imgBlob = null;
  var els = {};

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function render() {
    var text = els.src.value;
    var r = transposeText(text, shift, mode), html = [], i, warn = 0;
    last = r;
    for (i = 0; i < r.lines.length; i++) {
      html.push(r.lines[i].chordLine ? '<span class="cl">' + esc(r.lines[i].text) + '</span>'
        : r.lines[i].suspect ? '<span class="cw">' + esc(r.lines[i].text) + '</span>' : esc(r.lines[i].text));
      if (r.lines[i].suspect) warn++;
    }
    els.out.innerHTML = html.join('\n');
    els.shift.textContent = (shift > 0 ? '+' : shift < 0 ? '\u2212' : '') + Math.abs(shift);
    els.keyFrom.textContent = r.key ? r.key.name : '\u2013';
    els.keyTo.textContent = r.newKey || '\u2013';
    els.count.textContent = r.count + (r.count === 1 ? ' chord' : ' chords') + ' found' + (warn ? ' \u00b7 ' + warn + (warn === 1 ? ' line' : ' lines') + ' to check (yellow)' : '');
    els.copy.disabled = els.mk.disabled = !text.trim();
  }

  function setShift(n) {
    shift = ((n + 5) % 12 + 12) % 12 - 5;   // keep within -5..+6
    render();
  }

  function setStatus(msg, pct) {
    els.status.textContent = msg || '';
    els.bar.style.display = pct == null ? 'none' : 'block';
    if (pct != null) els.barFill.style.width = Math.round(pct * 100) + '%';
  }

  var stage = 'starting', busy = false;
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () {
        reject(new Error('Timed out while ' + label + '. Close other tabs and try again.'));
      }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  var workerLang = '';
  function getWorker(lang) {
    if (worker && workerLang !== lang) { try { worker.terminate(); } catch (x) {} worker = null; }
    if (worker) return Promise.resolve(worker);
    if (typeof WebAssembly !== 'object') return Promise.reject(new Error('This browser has no WebAssembly support.'));
    if (location.protocol === 'file:') {
      return Promise.reject(new Error('Open this page from GitHub Pages or a web server, not from a local file.'));
    }
    var base = new URL('.', location.href).href, w = null;
    // Tesseract.js v4: createWorker() returns a Promise and the worker loads its core by itself.
    return withTimeout(Tesseract.createWorker({
      workerPath: base + 'vendor/worker.min.js',
      corePath: base + 'vendor/core',
      langPath: base + 'vendor/lang',
      cacheMethod: 'none',
      workerBlobURL: false,
      logger: function (m) {
        if (!m.status || !busy) return;
        if (m.status === 'recognizing text') setStatus('Reading the image\u2026', 0.15 + m.progress * 0.85);
        else { stage = m.status; setStatus('Loading the reader (first time only): ' + m.status + '\u2026', 0.05 + (m.progress || 0) * 0.1); }
      }
    }), 90000, 'starting the reader (' + stage + ')')
      .then(function (ww) { w = ww; stage = 'language data'; return withTimeout(w.loadLanguage(lang), 90000, 'loading language data'); })
      .then(function () { stage = 'initialising'; return withTimeout(w.initialize(lang), 90000, 'initialising the reader'); })
      .then(function () { worker = w; workerLang = lang; return w; })
      .catch(function (e) { try { if (w) w.terminate(); } catch (x) {} throw e; });
  }

  function readImage(file) {
    els.read.disabled = true; busy = true;
    setStatus('Preparing image\u2026', 0.02);
    var url;
    loadImage(file).then(function (o) {
      url = o.url;
      var cv = prepare(o.img, els.boost.checked);
      return new Promise(function (res, rej) {
        cv.toBlob(function (b) { b ? res(b) : rej(new Error('Image too large for this device.')); }, 'image/png');
      });
    }).then(function (blob) {
      var lang = els.only.checked ? 'eng' : els.lang.value;
      return getWorker(lang).then(function (w) {
        return w.setParameters({
          tessedit_char_whitelist: els.only.checked ? 'ABCDEFGMabdgijlmnstu#/()+-0123456789|% .' : '',
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: '6'
        }).then(function () { return withTimeout(w.recognize(blob), 180000, 'reading the image'); });
      });
    }).then(function (res) {
      busy = false;
      els.src.value = rebuildText(res.data, { columns: els.cols.checked });
      setShift(0);
      setStatus('Done. Check the text below and fix any misread chords.', null);
      els.src.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      busy = false;
      if (worker) { try { worker.terminate(); } catch (x) {} worker = null; }
      setStatus('Could not read the image: ' + (e && e.message ? e.message : e), null);
    }).then(function () {
      busy = false;
      if (url) URL.revokeObjectURL(url);
      els.read.disabled = !els.file.files.length;
    });
  }

  function copyOut() {
    var text = els.out.textContent, done = function () {
      els.copy.textContent = 'Copied';
      setTimeout(function () { els.copy.textContent = 'Copy result'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var t = document.createElement('textarea');
      t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.focus(); t.select(); t.setSelectionRange(0, text.length);
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(t);
    }
  }


  /* ---------- Result image ---------- */
  var MONO = '"SF Mono", Menlo, Consolas, "Courier New", monospace';

  function makeImage() {
    if (!last) return;
    var dark = els.dark.checked, size = 30, pad = 44, lh = Math.round(size * 1.5);
    var lines = last.lines.slice(), head = last.newKey
      ? 'Key of ' + last.newKey + (shift ? '   (' + (shift > 0 ? '+' : '\u2212') + Math.abs(shift) + ')' : '') : '';
    var cv = document.createElement('canvas'), ctx = cv.getContext('2d'), i, w = 0, tw;
    ctx.font = 'bold ' + size + 'px ' + MONO;
    for (i = 0; i < lines.length; i++) { tw = ctx.measureText(lines[i].text).width; if (tw > w) w = tw; }
    var top = head ? lh * 1.6 : 0;
    var W = Math.ceil(Math.max(w, head ? ctx.measureText(head).width : 0) + pad * 2), H = Math.ceil(lines.length * lh + pad * 2 + top);
    var sc = 2;
    while (sc > 0.5 && (W * sc > 4096 || H * sc > 8192 || W * H * sc * sc > 12e6)) sc -= 0.25;
    cv.width = Math.round(W * sc); cv.height = Math.round(H * sc);
    ctx.scale(sc, sc);
    ctx.fillStyle = dark ? '#10171f' : '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic';
    var y = pad + size;
    if (head) {
      ctx.font = 'bold ' + Math.round(size * 0.8) + 'px -apple-system, "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = dark ? '#9aabbd' : '#5b6b80'; ctx.fillText(head, pad, y);
      y += top;
    }
    for (i = 0; i < lines.length; i++) {
      if (lines[i].chordLine) { ctx.font = 'bold ' + size + 'px ' + MONO; ctx.fillStyle = dark ? '#8fc0ff' : '#0b5fb8'; }
      else { ctx.font = size + 'px ' + MONO; ctx.fillStyle = dark ? '#e8eef5' : '#17263b'; }
      ctx.fillText(lines[i].text, pad, y);
      y += lh;
    }
    cv.toBlob(function (b) {
      if (!b) { els.imgNote.textContent = 'This chart is too big to turn into an image on this device.'; return; }
      if (imgUrl) URL.revokeObjectURL(imgUrl);
      imgBlob = b; imgUrl = URL.createObjectURL(b);
      els.resImg.src = imgUrl;
      els.imgBox.style.display = 'block';
      els.imgNote.textContent = 'Press and hold the image to save it, or use the buttons.';
      els.imgBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 'image/png');
  }

  function fileName() {
    return 'chords' + (last && last.newKey ? '-' + last.newKey.replace('#', 'sharp') : '') + '.png';
  }

  function saveImage() {
    if (!imgUrl) return;
    var a = document.createElement('a');
    a.href = imgUrl; a.download = fileName();
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  function shareImage() {
    if (!imgBlob) return;
    try {
      var f = new File([imgBlob], fileName(), { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [f] })) {
        navigator.share({ files: [f], title: 'Transposed chords' }).catch(function () {});
        return;
      }
    } catch (e) {}
    saveImage();
  }

  /* ---------- Full photo viewer ---------- */
  var zoom = 1;
  function setZoom(z) {
    zoom = Math.max(1, Math.min(4, z));
    els.viewImg.style.width = (zoom * 100) + '%';
    els.zlabel.textContent = Math.round(zoom * 100) + '%';
  }
  function openViewer() {
    if (!els.preview.src) return;
    els.viewImg.src = els.preview.src;
    els.viewer.style.display = 'block';
    document.body.style.overflow = 'hidden';
    setZoom(1); els.viewScroll.scrollTop = 0; els.viewScroll.scrollLeft = 0;
    els.vclose.focus();
  }
  function closeViewer() {
    els.viewer.style.display = 'none';
    document.body.style.overflow = '';
    els.open.focus();
  }

  function showVersion() {
    var meta = document.querySelector('meta[name="app-version"]'), t = 'ChordShift v' + VERSION + ' \u00b7 ' + BUILD_DATE;
    if (meta && meta.content !== VERSION) t += ' \u2014 page is v' + meta.content + ', reload to update';
    els.ver.textContent = t;
  }

  function init() {
    ['file','preview','read','only','boost','status','bar','barFill','src','shift','keyFrom','keyTo','count','out','copy','down','up','size','lang','mk','dark','imgBox','resImg','imgNote','save','share','open','viewer','viewImg','viewScroll','zlabel','vclose','zin','zout','zfit','ver','taller','shorter','cols'].forEach(function (k) { els[k] = $(k); });
    els.file.addEventListener('change', function () {
      var f = els.file.files[0];
      els.read.disabled = !f;
      if (!f) return;
      if (els.preview.dataset.url) URL.revokeObjectURL(els.preview.dataset.url);
      var u = URL.createObjectURL(f);
      els.preview.dataset.url = u; els.preview.src = u; els.preview.style.display = 'block';
      setStatus('', null);
    });
    els.read.addEventListener('click', function () { if (els.file.files[0]) readImage(els.file.files[0]); });
    els.src.addEventListener('input', render);
    els.down.addEventListener('click', function () { setShift(shift - 1); });
    els.up.addEventListener('click', function () { setShift(shift + 1); });
    els.copy.addEventListener('click', copyOut);
    els.size.addEventListener('input', function () { els.out.style.fontSize = els.src.style.fontSize = els.size.value + 'px'; });
    var radios = document.querySelectorAll('input[name=acc]'), i;
    for (i = 0; i < radios.length; i++) radios[i].addEventListener('change', function (e) { mode = e.target.value; render(); });
    els.mk.addEventListener('click', makeImage);
    els.save.addEventListener('click', saveImage);
    els.share.addEventListener('click', shareImage);
    els.open.addEventListener('click', openViewer);
    els.preview.addEventListener('click', openViewer);
    els.vclose.addEventListener('click', closeViewer);
    els.zin.addEventListener('click', function () { setZoom(zoom + 0.5); });
    els.zout.addEventListener('click', function () { setZoom(zoom - 0.5); });
    els.zfit.addEventListener('click', function () { setZoom(1); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && els.viewer.style.display === 'block') closeViewer(); });
    els.taller.addEventListener('click', function () { els.src.style.height = (els.src.offsetHeight + 160) + 'px'; });
    els.shorter.addEventListener('click', function () { els.src.style.height = Math.max(120, els.src.offsetHeight - 160) + 'px'; });
    els.file.addEventListener('change', function () { els.open.style.display = els.file.files.length ? 'inline-flex' : 'none'; });
    showVersion();
    render();
  }

  if (typeof window !== 'undefined') window.__cs = { setTarget: function (v) { TARGET_H = v; }, estimateTextHeight: estimateTextHeight, chooseScale: chooseScale, loadImage: loadImage, findGutter: findGutter };
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
  if (typeof module !== 'undefined') module.exports = { transposeText: transposeText, rebuildText: rebuildText, parseChord: parseChord };
})();
