/* Pure music helpers shared by the app and regression tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChordMusic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const ALIASES = { Db: 'C#', 'D#': 'Eb', Gb: 'F#', 'G#': 'Ab', 'A#': 'Bb', H: 'B' };
  const CHORDS = NOTES.flatMap(note => [note, `${note}m`]);
  const OPEN_CHORDS = ['C', 'D', 'Dm', 'E', 'Em', 'G', 'A', 'Am'];

  function normalizeChord(value) {
    const match = String(value || '').trim().replaceAll('♭', 'b').replaceAll('♯', '#').match(/^([A-H](?:#|b)?)(m)?$/);
    if (!match) return '?';
    const note = ALIASES[match[1]] || match[1];
    return NOTES.includes(note) ? note + (match[2] || '') : '?';
  }

  function transpose(chord, semitones) {
    chord = normalizeChord(chord);
    if (chord === '?') return '?';
    const minor = chord.endsWith('m');
    const note = minor ? chord.slice(0, -1) : chord;
    const index = (NOTES.indexOf(note) + semitones % 12 + 12) % 12;
    return NOTES[index] + (minor ? 'm' : '');
  }

  function chordNotes(chord) {
    chord = normalizeChord(chord);
    if (chord === '?') return [];
    const minor = chord.endsWith('m');
    const root = NOTES.indexOf(minor ? chord.slice(0, -1) : chord);
    return [root, (root + (minor ? 3 : 4)) % 12, (root + 7) % 12];
  }

  function capoOptions(segments, known) {
    const chords = [...new Set(segments.filter(s => !s.uncertain || s.corrected).map(s => normalizeChord(s.chord)).filter(c => c !== '?'))];
    return Array.from({ length: 8 }, (_, capo) => {
      const shapes = chords.map(chord => transpose(chord, -capo));
      const missing = shapes.filter(chord => !known.includes(chord));
      return { capo, shapes, missing, playable: shapes.length - missing.length, total: shapes.length };
    }).sort((a, b) => a.missing.length - b.missing.length || a.capo - b.capo);
  }

  function recommendChord(songs, known) {
    if (!songs.length) return null;
    const ranked = CHORDS.filter(chord => !known.includes(chord)).map(chord => {
      let unlocked = 0;
      let helped = 0;
      for (const song of songs) {
        const before = capoOptions(song.segments || [], known)[0];
        const after = capoOptions(song.segments || [], [...known, chord])[0];
        if (after.missing.length < before.missing.length) helped += 1;
        if (before.missing.length > 0 && after.missing.length === 0) unlocked += 1;
      }
      return { chord, unlocked, helped };
    });
    ranked.sort((a, b) => b.unlocked - a.unlocked || b.helped - a.helped || Number(OPEN_CHORDS.includes(b.chord)) - Number(OPEN_CHORDS.includes(a.chord)) || CHORDS.indexOf(a.chord) - CHORDS.indexOf(b.chord));
    return ranked[0]?.helped ? ranked[0] : null;
  }

  function activeIndex(segments, time) {
    return segments.findIndex(segment => time >= segment.time && time < segment.end);
  }

  function validLoop(start, end, duration) {
    return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end <= duration + 0.001 && end - start >= 0.3;
  }

  // HPCP is A-based. Rank simple triads for an audible comparison, not a probability.
  function rankChroma(chroma) {
    const norm = Math.sqrt(chroma.reduce((sum, value) => sum + value * value, 0));
    if (!norm) return [];
    return CHORDS.map(chord => ({
      chord,
      score: chordNotes(chord).reduce((sum, note) => sum + (chroma[(note + 3) % 12] || 0), 0) / (norm * Math.sqrt(3)),
    })).sort((a, b) => b.score - a.score);
  }

  return { NOTES, CHORDS, OPEN_CHORDS, normalizeChord, transpose, chordNotes, capoOptions, recommendChord, activeIndex, validLoop, rankChroma };
});
