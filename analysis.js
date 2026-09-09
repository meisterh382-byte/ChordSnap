(function (root, factory) {
  const music = typeof module === 'object' && module.exports ? require('./music.js') : root.ChordMusic;
  const api = factory(music);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChordAnalysis = api;
})(typeof self !== 'undefined' ? self : this, function (music) {
  'use strict';
  const SAMPLE_RATE = 44100; // TonalExtractor's internal SpectralPeaks uses this fixed rate.
  const FRAME_SIZE = 4096;
  const HOP_SIZE = 2048;
  const MIN_STRENGTH = 0.6; // Similarity heuristic, never a probability.

  function vectorArray(vector) {
    if (Array.isArray(vector) || ArrayBuffer.isView(vector)) return Array.from(vector);
    if (!vector || typeof vector.size !== 'function') return [];
    return Array.from({ length: vector.size() }, (_, i) => vector.get(i));
  }

  function release(result) {
    if (result) Object.values(result).forEach(value => value?.delete?.());
  }

  function rms(signal, start = 0, end = signal.length) {
    start = Math.max(0, Math.floor(start));
    end = Math.min(signal.length, Math.ceil(end));
    let energy = 0;
    for (let i = start; i < end; i += 1) energy += signal[i] * signal[i];
    return Math.sqrt(energy / Math.max(1, end - start));
  }

  async function prepareAudio(audioBuffer, OfflineContext) {
    const mono = new Float32Array(audioBuffer.length);
    let strongest = audioBuffer.getChannelData(0);
    let maxRms = rms(strongest);
    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      const level = rms(data);
      if (level > maxRms) { strongest = data; maxRms = level; }
      for (let i = 0; i < data.length; i += 1) mono[i] += data[i] / audioBuffer.numberOfChannels;
    }
    // Opposite-phase stereo must not turn a clear recording into silence.
    if (rms(mono) < maxRms * 0.2) mono.set(strongest);
    if (audioBuffer.sampleRate === SAMPLE_RATE) return mono;
    if (!OfflineContext) throw new Error('Dein Browser kann das Audioformat nicht umrechnen. Bitte aktualisiere Safari oder Chrome.');
    const context = new OfflineContext(1, Math.ceil(audioBuffer.duration * SAMPLE_RATE), SAMPLE_RATE);
    const input = context.createBuffer(1, mono.length, audioBuffer.sampleRate);
    input.copyToChannel(mono, 0);
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(context.destination);
    source.start();
    const rendered = await context.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  }

  function groupFrames(frames) {
    const groups = [];
    for (const frame of frames) {
      const last = groups[groups.length - 1];
      if (last?.chord === frame.chord && last.silent === frame.silent) {
        last.end = frame.end;
        last.frames.push(frame);
      } else groups.push({ chord: frame.chord, silent: frame.silent, time: frame.time, end: frame.end, frames: [frame] });
    }
    return groups;
  }

  function stabilizeFrames(frames) {
    // Remove brief chord islands. Preserve silence/unknown gaps and their timing.
    const cleaned = frames.map(frame => ({ ...frame }));
    const groups = groupFrames(cleaned);
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      if (group.chord === '?' || group.end - group.time >= 0.23) continue;
      const before = groups[i - 1];
      const after = groups[i + 1];
      const replacement = before?.chord === after?.chord && before?.chord !== '?' ? before?.chord : '?';
      group.frames.forEach(frame => { frame.chord = replacement || '?'; });
    }
    return groupFrames(cleaned).map(group => {
      const strength = group.frames.reduce((sum, frame) => sum + frame.strength, 0) / group.frames.length;
      const chroma = Array(12).fill(0);
      group.frames.forEach(frame => frame.chroma?.forEach((value, i) => { chroma[i] += value; }));
      const ranked = music.rankChroma(chroma).map(item => item.chord);
      const candidates = [...new Set([group.chord, ...ranked, ...group.frames.map(frame => frame.candidate)])].filter(chord => chord && chord !== '?').slice(0, 2);
      return { chord: group.chord, time: group.time, end: group.end, strength, uncertain: group.chord === '?', silent: group.silent, candidates };
    });
  }

  function coverage(segments) {
    return segments.reduce((total, segment) => total + (segment.uncertain ? 0 : segment.end - segment.time), 0);
  }

  function hasTonalAudio(engine, signal) {
    let checked = 0;
    let tonal = 0;
    // Broadband noise can receive a misleadingly strong tonictriad fallback.
    // Check spectral flatness on a bounded sample before asking for chords.
    const step = Math.max(FRAME_SIZE, Math.floor(signal.length / 12));
    for (let start = 0; start + FRAME_SIZE <= signal.length; start += step) {
      if (rms(signal, start, start + FRAME_SIZE) < 0.001) continue;
      let frame;
      let windowed;
      let spectrum;
      try {
        frame = engine.arrayToVector(signal.slice(start, start + FRAME_SIZE));
        windowed = engine.Windowing(frame, true, FRAME_SIZE, 'hann');
        spectrum = engine.Spectrum(windowed.frame, FRAME_SIZE);
        const values = vectorArray(spectrum.spectrum).slice(4);
        const arithmetic = values.reduce((sum, value) => sum + value, 0) / values.length;
        const geometric = Math.exp(values.reduce((sum, value) => sum + Math.log(Math.max(1e-12, value)), 0) / values.length);
        checked += 1;
        if (arithmetic > 0 && geometric / arithmetic < 0.35) tonal += 1;
      } finally { release(spectrum); release(windowed); frame?.delete?.(); }
    }
    return checked > 0 && tonal / checked >= 0.25;
  }

  function makeFrame(chord, strength, time, end, signal, threshold, chroma) {
    const silent = rms(signal, time * SAMPLE_RATE, end * SAMPLE_RATE) < threshold;
    const candidate = music.normalizeChord(chord);
    strength = Number.isFinite(Number(strength)) ? Number(strength) : 0;
    return { time, end, candidate, chord: !silent && strength >= MIN_STRENGTH ? candidate : '?', strength, silent, chroma };
  }

  function fallbackFrames(engine, signal, threshold) {
    const frames = [];
    const duration = signal.length / SAMPLE_RATE;
    for (let time = 0; time < duration; time += 0.25) {
      const end = Math.min(time + 0.25, duration);
      const center = (time + end) / 2;
      const startSample = Math.max(0, Math.round((center - 0.375) * SAMPLE_RATE));
      const endSample = Math.min(signal.length, Math.round((center + 0.375) * SAMPLE_RATE));
      if (rms(signal, time * SAMPLE_RATE, end * SAMPLE_RATE) < threshold) {
        frames.push(makeFrame('?', 0, time, end, signal, threshold));
        continue;
      }
      let vector;
      try {
        vector = engine.arrayToVector(signal.slice(startSample, endSample));
        const estimate = engine.KeyExtractor(vector, true, 4096, 2048, 12, 3500, 60, 25, 0.2, 'tonictriad', SAMPLE_RATE, 0.0001, 440, 'cosine', 'hann');
        const chord = estimate.key + (estimate.scale === 'minor' ? 'm' : '');
        frames.push(makeFrame(chord, estimate.strength, time, end, signal, threshold));
      } finally { vector?.delete?.(); }
    }
    return stabilizeFrames(frames);
  }

  function analyzeMono(engine, signal, sampleRate = SAMPLE_RATE) {
    if (sampleRate !== SAMPLE_RATE) throw new Error('Audio muss vor der Analyse auf 44,1 kHz umgerechnet werden.');
    const duration = signal.length / SAMPLE_RATE;
    if (duration < 0.5) throw new Error('Die Aufnahme ist zu kurz. Nimm mindestens eine halbe Sekunde auf, besser 10 bis 30 Sekunden.');
    if (duration > 60.05) throw new Error('Bitte verwende einen Ausschnitt mit höchstens 60 Sekunden.');
    const level = rms(signal);
    if (level < 0.001) return { segments: [], duration, reason: 'quiet', usedFallback: false };
    if (!hasTonalAudio(engine, signal)) return { segments: [{ chord: '?', time: 0, end: duration, strength: 0, uncertain: true, silent: false, candidates: [] }], duration, reason: 'uncertain', usedFallback: false };
    const threshold = Math.max(0.001, level * 0.04);
    let signalVector;
    let tonal;
    let detection;
    let segments = [];
    let primaryError;
    try {
      signalVector = engine.arrayToVector(signal);
      tonal = engine.TonalExtractor(signalVector, FRAME_SIZE, HOP_SIZE, 440);
      // Explicitly set rate/hop and use a shorter context for musical changes.
      detection = engine.ChordsDetection(tonal.hpcp, HOP_SIZE, SAMPLE_RATE, 0.65);
      const chords = vectorArray(detection.chords);
      const strengths = vectorArray(detection.strength);
      const frames = [];
      for (let i = 0; i < chords.length; i += 1) {
        const time = i * HOP_SIZE / SAMPLE_RATE;
        if (time >= duration) break;
        let profile;
        const chroma = Array(12).fill(0);
        try {
          profile = tonal.hpcp.get(i);
          vectorArray(profile).forEach((value, bin) => { chroma[Math.round(bin / 3) % 12] += value; });
        } finally { profile?.delete?.(); }
        frames.push(makeFrame(chords[i], strengths[i], time, Math.min(duration, (i + 1) * HOP_SIZE / SAMPLE_RATE), signal, threshold, chroma));
      }
      segments = stabilizeFrames(frames);
    } catch (error) { primaryError = error; }
    finally { release(detection); release(tonal); signalVector?.delete?.(); }

    let usedFallback = false;
    // An all-unknown result or an exception must also reach the fallback.
    if (coverage(segments) < 0.25) {
      try {
        const fallback = fallbackFrames(engine, signal, threshold);
        if (coverage(fallback) > coverage(segments)) { segments = fallback; usedFallback = true; }
      } catch (error) {
        if (primaryError) throw new Error('Die Audioanalyse konnte nicht ausgeführt werden. Bitte lade die Seite neu und versuche es erneut.');
      }
    }
    const clipped = signal.reduce((count, sample) => count + (Math.abs(sample) >= 0.99 ? 1 : 0), 0) / signal.length > 0.01;
    return { segments, duration, usedFallback, clipped, reason: coverage(segments) >= 0.25 ? 'ok' : 'uncertain' };
  }

  return { SAMPLE_RATE, prepareAudio, analyzeMono, stabilizeFrames, coverage, rms };
});
