/* A synthetic, labelled test recording. No prerecorded chord results. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChordDemo = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function signal(sampleRate = 48000, chords = [[48, 52, 55, 60, 64], [43, 47, 50, 55, 59], [45, 52, 57, 60, 64], [41, 48, 53, 57, 60]], seconds = 2) {
    return Float32Array.from({ length: Math.round(sampleRate * seconds * chords.length) }, (_, i) => {
      const t = i / sampleRate;
      const notes = chords[Math.min(chords.length - 1, Math.floor(t / seconds))];
      const local = t % seconds;
      const envelope = Math.min(1, local / 0.025, (seconds - local) / 0.025) * (0.7 + 0.3 * Math.exp(-local * 2));
      return notes.reduce((sum, midi) => {
        const f = 440 * 2 ** ((midi - 69) / 12);
        return sum + [1, 2, 3, 4].reduce((s, h) => s + Math.sin(2 * Math.PI * f * h * t) / (h * h), 0);
      }, 0) * 0.28 * envelope / notes.length;
    });
  }
  function wav(samples, rate = 48000) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
    text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true));
    return buffer;
  }
  return { signal, wav };
});
