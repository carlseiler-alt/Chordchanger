# ChordShift

Photo of a chord chart → text → transposed chart. Runs fully in the browser (Tesseract.js OCR, hosted locally in `vendor/`), no server, no uploads. Built for old Safari (iOS 15).

## Publish on GitHub Pages
1. Create a repo and upload everything in this folder (keep `.nojekyll` and the `vendor/` folder).
2. Settings → Pages → Deploy from branch → `main` / root.
3. Open `https://<user>.github.io/<repo>/` on the phone.

Must be served over http(s); opening `index.html` as a local file won't work (browsers block the OCR worker).

## Notes
- Recognised: C, F#m7b5, Bbmaj7, Cadd9, Asus4, D/F#, `| G | D |` bars, and inline `[Am]` ChordPro chords.
- Only lines made entirely of chords are transposed, so lyrics like "Am I" are left alone. Recognised chord lines are highlighted.
- OCR can misread chords. Always glance at the "Chart text" box before transposing.
