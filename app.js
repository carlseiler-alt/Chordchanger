/* ChordShift – chord transposition + OCR glue. Plain ES5-style JS for old Safari (iOS 15). */
(function () {
  'use strict';

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
    var re = /\S+/g, m, out = [];
    while ((m = re.exec(line)) !== null) out.push({ text: m[0], index: m.index });
    return out;
  }

  function isChordLine(line) {
    var toks = tokenize(line), chords = 0, i, core;
    if (!toks.length) return false;
    for (i = 0; i < toks.length; i++) {
      core = splitToken(toks[i].text).core;
      if (core === '') continue;
      if (parseChord(core)) chords++;
      else if (!IGNORE_RE.test(core)) return false;
    }
    return chords > 0;
  }

  function findKey(text) {
    var lines = normalise(text).split('\n'), i, j, toks, c;
    for (i = 0; i < lines.length; i++) {
      if (/\[[^\]]+\]/.test(lines[i])) {
        var br = /\[([^\]]+)\]/g, m;
        while ((m = br.exec(lines[i])) !== null) {
          c = parseChord(m[1].trim());
          if (c) return { pc: pcOf(c.root), minor: isMinor(c.qual), name: c.root + (isMinor(c.qual) ? 'm' : '') };
        }
      } else if (isChordLine(lines[i])) {
        toks = tokenize(lines[i]);
        for (j = 0; j < toks.length; j++) {
          c = parseChord(splitToken(toks[j].text).core);
          if (c) return { pc: pcOf(c.root), minor: isMinor(c.qual), name: c.root + (isMinor(c.qual) ? 'm' : '') };
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

  function transposeLine(line, shift, flats, stats) {
    if (/\[[^\]]+\]/.test(line)) {
      var did = false;
      var res = line.replace(/\[([^\]]+)\]/g, function (all, inner) {
        var c = parseChord(inner.trim());
        if (!c) return all;
        did = true; stats.count++;
        return '[' + shiftChord(c, shift, flats) + ']';
      });
      return { text: res, chordLine: did };
    }
    if (!isChordLine(line)) return { text: line, chordLine: false };

    var toks = tokenize(line), out = '', i, parts, c, rep, col;
    for (i = 0; i < toks.length; i++) {
      parts = splitToken(toks[i].text);
      c = parts.core ? parseChord(parts.core) : null;
      if (c) { rep = shiftChord(c, shift, flats); stats.count++; } else rep = parts.core;
      rep = parts.pre + rep + parts.post;
      col = toks[i].index;
      if (out.length < col) out += new Array(col - out.length + 1).join(' ');
      else if (out.length > 0) out += ' ';
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
      res.push({ text: r.text.replace(/\s+$/, ''), chordLine: r.chordLine });
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

  function rebuildText(data) {
    var lines = data && data.lines;
    if (!lines || !lines.length) return (data && data.text) || '';
    var widths = [], heights = [], minX = Infinity, i, j, w, L;
    for (i = 0; i < lines.length; i++) {
      L = lines[i];
      if (L.bbox) heights.push(L.bbox.y1 - L.bbox.y0);
      for (j = 0; j < (L.words || []).length; j++) {
        w = L.words[j];
        if (w.bbox.x0 < minX) minX = w.bbox.x0;
        if (w.text.length >= 2) widths.push((w.bbox.x1 - w.bbox.x0) / w.text.length);
      }
    }
    var charW = median(widths) || 10, lineH = median(heights) || 30;
    var out = [], prev = null, row, col, word;
    for (i = 0; i < lines.length; i++) {
      L = lines[i];
      if (!L.words || !L.words.length) continue;
      if (prev && L.bbox && (L.bbox.y0 - prev.bbox.y1) > lineH * 1.6) out.push('');
      row = '';
      for (j = 0; j < L.words.length; j++) {
        word = L.words[j];
        if (!word.text.trim()) continue;
        col = Math.round((word.bbox.x0 - minX) / charW);
        if (row.length < col) row += new Array(col - row.length + 1).join(' ');
        else if (row.length > 0) row += ' ';
        row += word.text.trim();
      }
      out.push(row);
      prev = L;
    }
    return out.join('\n');
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

  function prepare(img, boost) {
    var w = img.naturalWidth, h = img.naturalHeight, long = Math.max(w, h);
    var target = long < 1600 ? 2000 : Math.min(long, 2600);
    var s = target / long;
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
  var shift = 0, mode = 'auto', worker = null;
  var els = {};

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function render() {
    var text = els.src.value;
    var r = transposeText(text, shift, mode), html = [], i;
    for (i = 0; i < r.lines.length; i++) {
      html.push(r.lines[i].chordLine ? '<span class="cl">' + esc(r.lines[i].text) + '</span>' : esc(r.lines[i].text));
    }
    els.out.innerHTML = html.join('\n');
    els.shift.textContent = (shift > 0 ? '+' : shift < 0 ? '\u2212' : '') + Math.abs(shift);
    els.keyFrom.textContent = r.key ? r.key.name : '\u2013';
    els.keyTo.textContent = r.newKey || '\u2013';
    els.count.textContent = r.count + (r.count === 1 ? ' chord' : ' chords') + ' found';
    els.copy.disabled = !text.trim();
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

  function getWorker() {
    if (worker) return Promise.resolve(worker);
    if (location.protocol === 'file:') {
      return Promise.reject(new Error('Open this page from GitHub Pages or a web server, not from a local file.'));
    }
    var base = new URL('.', location.href).href, w;
    w = Tesseract.createWorker({
      workerPath: base + 'vendor/worker.min.js',
      corePath: base + 'vendor/core',
      langPath: base + 'vendor/lang',
      cacheMethod: 'none',
      workerBlobURL: false,
      logger: function (m) {
        if (m.status === 'recognizing text') setStatus('Reading the image\u2026', 0.15 + m.progress * 0.85);
        else if (m.status && /load|init/.test(m.status)) setStatus('Loading the reader (first time only)\u2026', 0.05 + (m.progress || 0) * 0.1);
      }
    });
    return w.load().then(function () { return w.loadLanguage('eng'); })
      .then(function () { return w.initialize('eng'); })
      .then(function () { worker = w; return w; });
  }

  function readImage(file) {
    els.read.disabled = true;
    setStatus('Preparing image\u2026', 0.02);
    var url;
    loadImage(file).then(function (o) {
      url = o.url;
      var cv = prepare(o.img, els.boost.checked);
      return new Promise(function (res, rej) {
        cv.toBlob(function (b) { b ? res(b) : rej(new Error('Image too large for this device.')); }, 'image/png');
      });
    }).then(function (blob) {
      return getWorker().then(function (w) {
        return w.setParameters({
          tessedit_char_whitelist: els.only.checked ? 'ABCDEFGMabdgijlmnstu#/()+-0123456789|% .' : '',
          preserve_interword_spaces: '1',
          tessedit_pageseg_mode: els.only.checked ? '11' : '6'
        }).then(function () { return w.recognize(blob); });
      });
    }).then(function (res) {
      els.src.value = rebuildText(res.data);
      setShift(0);
      setStatus('Done. Check the text below and fix any misread chords.', null);
      els.src.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) {
      if (worker) { try { worker.terminate(); } catch (x) {} worker = null; }
      setStatus('Could not read the image: ' + (e && e.message ? e.message : e), null);
    }).then(function () {
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

  function init() {
    ['file','preview','read','only','boost','status','bar','barFill','src','shift','keyFrom','keyTo','count','out','copy','down','up','size'].forEach(function (k) { els[k] = $(k); });
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
    render();
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
  if (typeof module !== 'undefined') module.exports = { transposeText: transposeText, rebuildText: rebuildText, parseChord: parseChord };
})();
