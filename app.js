'use strict';
const $ = selector => document.querySelector(selector);
const music = ChordMusic;
const audioPlayer = $('#audio-player');
const MAX_SECONDS = 60;
let currentBlob;
let currentUrl;
let segments = [];
let duration = 0;
let songId = null;
let songs = [];
let dirty = false;
let busy = false;
let recording = false;
let selected = -1;
let capo = 0;
let capoMode = 'original';
let loop = null;
let previewEnd = null;
let mediaRecorder;
let mediaStream;
let recordTimer;
let meterContext;
let renderFrame;
let essentiaReady;
let engine;
let synthContext;
let voices = [];
let learningRecommendation;
let known = [];
let preferenceError = false;
try {
  const saved = JSON.parse(localStorage.getItem('chordsnap-known-grips') || '[]');
  known = Array.isArray(saved) ? [...new Set(saved.map(music.normalizeChord).filter(c => c !== '?'))] : [];
} catch { preferenceError = true; }

function chordLabel(chord) { return chord.replaceAll('b', '♭').replaceAll('#', '♯'); }
function timeLabel(time) {
  if (!Number.isFinite(time)) return '00:00';
  return `${Math.floor(time / 60).toString().padStart(2, '0')}:${Math.floor(time % 60).toString().padStart(2, '0')}`;
}
function setState(type, title, detail) {
  $('#status-dot').className = `status-dot ${type || ''}`;
  $('#status-text').textContent = title;
  $('#message').textContent = detail;
}
function button(label, className, action) {
  const element = document.createElement('button');
  element.type = 'button'; element.className = className; element.textContent = label;
  element.addEventListener('click', action);
  return element;
}
function setBusy(value) {
  busy = value;
  $('#record-button').disabled = value || recording;
  $('#analyze-button').disabled = value || recording || !currentBlob;
  $('#demo-button').disabled = value || recording;
  $('#audio-file').disabled = value || recording;
  $('#backup-file').disabled = value || recording;
  $('#save-song').disabled = value || recording;
  document.querySelectorAll('.song-actions button').forEach(element => { element.disabled = value || recording; });
}
function allowReplace() { return !dirty || window.confirm('Deine Änderungen sind noch nicht gespeichert. Diesen Ausschnitt trotzdem verlassen?'); }
function markDirty() {
  dirty = true;
  $('#save-message').textContent = songId ? 'Ungespeicherte Änderungen – speichere den Song erneut.' : 'Noch nicht gespeichert. Aufnahme und Akkorde bleiben bis zum Schließen dieser Seite verfügbar.';
}

function resetLoop() {
  loop = null;
  $('#loop-toggle').setAttribute('aria-pressed', 'false');
  $('#loop-toggle').textContent = 'Schleife einschalten';
}
function loadAudio(blob, title = '', stored = null) {
  audioPlayer.pause(); stopVoices(); resetLoop(); previewEnd = null;
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentBlob = blob;
  currentUrl = URL.createObjectURL(blob);
  audioPlayer.src = currentUrl;
  audioPlayer.playbackRate = 1;
  $('#playback-rate').value = '1';
  segments = stored?.segments ? structuredClone(stored.segments) : [];
  duration = stored?.duration || 0;
  songId = stored?.id || null;
  selected = -1;
  dirty = false;
  capo = stored?.capo || 0;
  capoMode = stored?.capoMode || 'original';
  $('#song-name').value = title;
  $('#playback-title').textContent = title || 'Deine Aufnahme';
  $('#duration-label').textContent = duration ? timeLabel(duration) : '';
  $('#playback-section').hidden = false;
  $('#result-section').hidden = !segments.length;
  $('#editor').hidden = true;
  $('#analyze-button').textContent = segments.length ? 'Aufnahme neu analysieren' : 'Akkorde erkennen';
  $('#save-message').textContent = stored ? 'Gespeicherten Song geöffnet. Änderungen werden erst mit „Song speichern“ übernommen.' : 'Speichert Aufnahme, Akkorde und Korrekturen auf diesem Gerät.';
  $('#loop-start').value = '0';
  $('#loop-end').value = Math.min(2, duration || 2).toFixed(1);
  document.querySelectorAll('[name="capo-mode"]').forEach(input => { input.checked = input.value === capoMode; });
  if (segments.length) { updateCapo(); renderSegments(); updateAnalysisNote(); }
  setBusy(false);
}

async function loadEssentia() {
  if (!essentiaReady) {
    if (typeof EssentiaWASM !== 'function' || typeof Essentia === 'undefined') throw new Error('Die Audioanalyse konnte nicht geladen werden. Prüfe deine Internetverbindung und lade die Seite neu.');
    essentiaReady = EssentiaWASM().then(module => { engine = new Essentia(module); return engine; }).catch(error => { essentiaReady = null; throw error; });
  }
  return essentiaReady;
}

async function analyzeRecording() {
  if (busy || recording || !currentBlob) return;
  if (segments.some(segment => segment.corrected) && !window.confirm('Neu analysieren ersetzt deine Akkordkorrekturen. Fortfahren?')) return;
  audioPlayer.pause(); stopVoices(); resetLoop(); previewEnd = null;
  setBusy(true);
  $('#analyze-button').textContent = 'Analysiere …';
  setState('', 'Ich höre genau hin …', 'Die Analyse läuft auf deinem Gerät. Das kann einen Moment dauern.');
  let context;
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) throw new Error('Dieser Browser unterstützt die Audioanalyse nicht. Bitte verwende einen aktuellen Safari oder Chrome.');
    context = new Context();
    const decoded = await context.decodeAudioData(await currentBlob.arrayBuffer());
    if (decoded.duration > MAX_SECONDS + 0.05) throw new Error('Bitte öffne einen Ausschnitt mit höchstens 60 Sekunden.');
    const mono = await ChordAnalysis.prepareAudio(decoded, window.OfflineAudioContext || window.webkitOfflineAudioContext);
    const analyzer = await loadEssentia();
    await new Promise(resolve => setTimeout(resolve, 30));
    const result = ChordAnalysis.analyzeMono(analyzer, mono);
    segments = result.segments;
    duration = result.duration;
    selected = -1;
    $('#editor').hidden = true;
    $('#loop-end').value = Math.min(2, duration).toFixed(1);
    $('#duration-label').textContent = timeLabel(duration);
    $('#result-section').hidden = !segments.length;
    if (segments.length) { updateCapo(); renderSegments(); updateAnalysisNote(result); markDirty(); }
    const reliable = segments.filter(segment => !segment.uncertain).length;
    if (result.reason === 'quiet') setState('warning', 'Die Aufnahme ist zu leise.', 'Ich habe keine ausreichend laute Musik gefunden. Gehe etwas näher an die Gitarre oder den Lautsprecher.');
    else if (!reliable) setState('warning', 'Noch keine verlässlichen Akkorde.', 'Die Stellen bleiben als „?“ sichtbar. Höre hinein, korrigiere sie oder versuche eine klarere Aufnahme.');
    else setState(result.clipped ? 'warning' : 'success', 'Deine Akkordfolge ist bereit.', result.clipped ? 'Die Aufnahme übersteuert an einigen Stellen. Nimm für bessere Ergebnisse etwas leiser auf.' : `${reliable} Akkordabschnitte gefunden. Prüfe sie beim Mitspielen mit deinem Ohr.`);
  } catch (error) {
    console.error(error);
    setState('error', 'Analyse nicht abgeschlossen.', error instanceof Error ? error.message : 'Bitte lade die Seite neu und versuche die Analyse noch einmal.');
    // A fatal WASM exception must not poison every later attempt.
    essentiaReady = null; engine = null;
  } finally {
    if (context && context.state !== 'closed') await context.close().catch(() => {});
    setBusy(false);
    $('#analyze-button').textContent = segments.length ? 'Aufnahme neu analysieren' : 'Akkorde erkennen';
  }
}

function cleanupMicrophone() {
  clearInterval(recordTimer);
  mediaStream?.getTracks().forEach(track => track.stop());
  mediaStream = null;
  if (meterContext && meterContext.state !== 'closed') meterContext.close().catch(() => {});
  meterContext = null;
  $('#input-level').hidden = true;
  $('#record-display').classList.remove('is-recording');
}
async function startRecording() {
  if (busy || recording || !allowReplace()) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setState('error', 'Aufnahme hier nicht verfügbar.', 'Öffne die App in einem aktuellen Browser über HTTPS. Du kannst auch eine Audiodatei öffnen.'); return;
  }
  audioPlayer.pause(); stopVoices();
  setBusy(true);
  setState('', 'Mikrofon wird geöffnet …', 'Erlaube den Mikrofonzugriff, wenn dein Browser danach fragt.');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    const started = performance.now();
    let failed = false;
    mediaRecorder.addEventListener('dataavailable', event => { if (event.data.size) chunks.push(event.data); });
    mediaRecorder.addEventListener('error', () => {
      failed = true; recording = false; cleanupMicrophone(); setBusy(false); $('#stop-button').disabled = true;
      setState('error', 'Die Aufnahme wurde unterbrochen.', 'Bitte versuche es erneut. Dein vorheriger Ausschnitt ist weiterhin verfügbar.');
    });
    mediaRecorder.addEventListener('stop', () => {
      recording = false; cleanupMicrophone(); setBusy(false); $('#stop-button').disabled = true;
      $('#record-button').textContent = 'Neue Aufnahme starten';
      if (failed) return;
      const blob = new Blob(chunks, { type: mediaRecorder.mimeType || chunks[0]?.type || 'audio/mp4' });
      if (!blob.size) { setState('warning', 'Keine Aufnahme empfangen.', 'Bitte nimm noch einmal mindestens ein paar Sekunden auf.'); return; }
      loadAudio(blob);
      dirty = true;
      setState('success', 'Aufnahme fertig.', 'Höre sie kurz an und starte dann die Akkorderkennung.');
    }, { once: true });
    mediaRecorder.start(500);
    recording = true; setBusy(false);
    $('#stop-button').disabled = false;
    $('#record-display').classList.add('is-recording');
    $('#record-hint').textContent = 'Ich höre zu · höchstens 60 Sekunden';
    setState('recording', 'Aufnahme läuft.', 'Spiele deinen Ausschnitt ab und tippe danach auf „Aufnahme stoppen“.');
    let analyser;
    let samples;
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      meterContext = new Context();
      meterContext.resume().catch(() => {});
      analyser = meterContext.createAnalyser(); analyser.fftSize = 1024;
      meterContext.createMediaStreamSource(mediaStream).connect(analyser);
      samples = new Float32Array(analyser.fftSize);
      $('#input-level').hidden = false;
    } catch { /* Recording remains available if a level meter is unsupported. */ }
    recordTimer = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      $('#record-timer').textContent = timeLabel(elapsed);
      if (analyser) { analyser.getFloatTimeDomainData(samples); $('#input-level').value = Math.min(1, ChordAnalysis.rms(samples) * 5); }
      if (elapsed >= MAX_SECONDS) stopRecording();
    }, 100);
    mediaStream.getAudioTracks().forEach(track => track.addEventListener('ended', stopRecording, { once: true }));
  } catch (error) {
    recording = false; cleanupMicrophone(); setBusy(false);
    setState('error', 'Mikrofon konnte nicht geöffnet werden.', error?.name === 'NotAllowedError' ? 'Erlaube den Mikrofonzugriff in den Website-Einstellungen und versuche es erneut.' : 'Prüfe, ob dein Mikrofon verfügbar ist. Alternativ kannst du eine Audiodatei öffnen.');
  }
}
function stopRecording() {
  if (mediaRecorder?.state !== 'recording') return;
  $('#stop-button').disabled = true;
  mediaRecorder.stop();
  cleanupMicrophone();
  $('#record-hint').textContent = '10–30 Sekunden sind ein guter Anfang';
}

function updateAnalysisNote(result) {
  const count = segments.filter(s => !s.uncertain).length;
  const unknown = segments.filter(s => s.uncertain && !s.silent).length;
  $('#confidence-label').textContent = unknown ? `${unknown} unklare Stellen` : `${count} Akkordabschnitte`;
  $('#analysis-note').textContent = result?.usedFallback ? 'Ersatzanalyse: Diese Kandidaten bitte besonders sorgfältig nach Gehör prüfen.' : 'Geschätzte Dur- und Mollakkorde. Korrekturen sind mit „von dir“ markiert.';
}
function updateCapo() {
  const options = music.capoOptions(segments, known);
  if (capoMode === 'personal') capo = known.length ? options[0].capo : 0;
  if (capoMode === 'original') capo = 0;
  $('#capo-select').value = String(capo);
  const option = options.find(item => item.capo === capo);
  const position = capo ? `Capo im ${capo}. Bund` : 'Ohne Capo';
  $('#capo-summary').textContent = !known.length ? 'Wähle zuerst deine bekannten Griffe. Die Aufnahme bleibt immer in der Originaltonhöhe.' : !option.total ? 'Noch keine sicheren Akkorde für eine Capo-Empfehlung. Prüfe zuerst die unklaren Stellen.' : `${position} · ${option.playable} von ${option.total} Griffen kannst du.${option.missing.length ? ` Noch offen: ${option.missing.map(chordLabel).join(', ')}.` : ' Alle erkannten Griffe passen zu dir.'}`;
  renderSegments();
}
function renderSegments() {
  const list = $('#chord-list'); list.replaceChildren();
  segments.forEach((segment, index) => {
    const shape = music.transpose(segment.chord, -capo);
    const card = button('', 'chord-card', () => selectSegment(index));
    card.setAttribute('aria-label', `${segment.silent ? 'Pause' : chordLabel(shape)}, ${segment.time.toFixed(1)} Sekunden, prüfen`);
    card.dataset.index = index;
    if (segment.uncertain) card.classList.add('uncertain');
    if (index === selected) card.classList.add('selected');
    const time = document.createElement('span'); time.className = 'chord-time'; time.textContent = `${segment.time.toFixed(1)} s`;
    const label = document.createElement('strong'); label.textContent = segment.silent && !segment.corrected ? '–' : chordLabel(shape);
    const hint = document.createElement('span'); hint.className = 'chord-hint';
    hint.textContent = segment.corrected ? 'von dir' : segment.silent ? 'Pause' : segment.uncertain ? 'unklar' : known.includes(shape) ? 'kann ich' : 'zum Üben';
    card.append(time, label, hint); list.append(card);
  });
  updatePlayback();
}
function updatePlayback() {
  const time = audioPlayer.currentTime || 0;
  const index = music.activeIndex(segments, time);
  const current = segments[index];
  const next = segments[index + 1];
  $('#current-chord').textContent = current ? current.silent && !current.corrected ? '–' : chordLabel(music.transpose(current.chord, -capo)) : '–';
  $('#sounding-chord').textContent = current?.chord && current.chord !== '?' ? `${capo ? `Capo ${capo} · klingt ${chordLabel(current.chord)}` : 'Originaltonhöhe'}${current.corrected ? ' · von dir' : ''}` : current?.silent ? 'Pause / sehr leise' : 'Noch unklar';
  $('#next-chord').textContent = next ? next.silent && !next.corrected ? '–' : chordLabel(music.transpose(next.chord, -capo)) : '–';
  $('#next-time').textContent = next ? `in ${Math.max(0, (next.time - time) / audioPlayer.playbackRate).toFixed(1)} s` : 'Ende der Folge';
  document.querySelectorAll('.chord-card').forEach((card, i) => {
    card.classList.toggle('active', i === index);
    if (i === index) card.setAttribute('aria-current', 'true'); else card.removeAttribute('aria-current');
  });
}
function playbackTick() {
  if (audioPlayer.paused) return;
  if (loop && audioPlayer.currentTime >= loop.end) audioPlayer.currentTime = loop.start;
  if (previewEnd !== null && audioPlayer.currentTime >= previewEnd) { audioPlayer.pause(); previewEnd = null; }
  updatePlayback();
  if (!audioPlayer.paused) renderFrame = requestAnimationFrame(playbackTick);
}
async function playAudio() {
  try { stopVoices(); await audioPlayer.play(); }
  catch { setState('warning', 'Wiedergabe nicht gestartet.', 'Tippe noch einmal auf den Play-Knopf im Audioplayer.'); }
}
function selectSegment(index) {
  selected = index; previewEnd = null;
  const segment = segments[index];
  if (loop && (segment.time < loop.start || segment.time >= loop.end)) resetLoop();
  audioPlayer.currentTime = segment.time;
  $('#editor').hidden = false;
  $('#editor-title').textContent = `Akkord bei ${segment.time.toFixed(1)} s prüfen`;
  $('#editor-detail').textContent = `${segment.time.toFixed(1)}–${segment.end.toFixed(1)} s · ${segment.corrected ? 'von dir korrigiert' : segment.silent ? 'Pause oder sehr leise' : segment.uncertain ? 'Erkennung unklar' : `geschätzt: ${chordLabel(segment.chord)}`}${capo ? ` · Du spielst mit Capo ${capo}, korrigiert wird der klingende Akkord.` : ''}`;
  $('#chord-correction').value = segment.chord;
  $('#reset-correction').hidden = !segment.corrected;
  const candidates = $('#candidate-buttons'); candidates.replaceChildren();
  const choices = [...new Set([segment.chord, ...(segment.candidates || [])])].filter(chord => chord !== '?').slice(0, 2);
  choices.forEach(chord => candidates.append(button(`${chordLabel(chord)} anhören`, 'secondary-button', () => { $('#chord-correction').value = chord; previewChord(chord); })));
  renderSegments();
}
function stopVoices() { voices.forEach(voice => { try { voice.stop(); } catch {} }); voices = []; }
async function previewChord(chord) {
  const notes = music.chordNotes(chord);
  if (!notes.length) return;
  audioPlayer.pause(); previewEnd = null; stopVoices();
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    synthContext ||= new Context(); await synthContext.resume();
    const start = synthContext.currentTime;
    const root = notes[0];
    notes.forEach((note, index) => {
      const oscillator = synthContext.createOscillator(); const gain = synthContext.createGain();
      const midi = 48 + note + (note < root ? 12 : 0);
      oscillator.type = 'triangle'; oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
      gain.gain.setValueAtTime(0, start); gain.gain.linearRampToValueAtTime(0.07, start + 0.025 + index * 0.025); gain.gain.exponentialRampToValueAtTime(0.001, start + 1.3);
      oscillator.connect(gain).connect(synthContext.destination);
      oscillator.start(start + index * 0.025); oscillator.stop(start + 1.4);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      voices.push(oscillator);
    });
  } catch { setState('warning', 'Hörvergleich nicht verfügbar.', 'Bitte prüfe die Tonfreigabe deines Browsers.'); }
}
function applyCorrection() {
  if (selected < 0) return;
  const segment = segments[selected];
  if (!segment.original) segment.original = { chord: segment.chord, uncertain: segment.uncertain, silent: segment.silent };
  segment.chord = music.normalizeChord($('#chord-correction').value);
  segment.uncertain = segment.chord === '?'; segment.silent = false; segment.corrected = true;
  markDirty(); updateCapo(); selectSegment(selected); updateAnalysisNote();
}
function toggleLoop() {
  if (loop) { resetLoop(); $('#loop-message').textContent = 'Schleife ausgeschaltet.'; return; }
  const start = Number($('#loop-start').value); const end = Number($('#loop-end').value);
  if (!music.validLoop(start, end, duration)) { $('#loop-message').textContent = `Wähle mindestens 0,3 Sekunden zwischen 0 und ${duration.toFixed(1)} Sekunden.`; return; }
  loop = { start, end }; previewEnd = null;
  $('#loop-toggle').setAttribute('aria-pressed', 'true'); $('#loop-toggle').textContent = 'Schleife ausschalten';
  $('#loop-message').textContent = `Wiederholt ${start.toFixed(1)}–${end.toFixed(1)} s. Mitspielen startet die Wiedergabe.`;
  audioPlayer.currentTime = start;
}

function renderGrips() {
  $('#known-grips').replaceChildren(); $('#more-grips').replaceChildren();
  [...music.OPEN_CHORDS, ...music.CHORDS.filter(chord => !music.OPEN_CHORDS.includes(chord))].forEach(chord => {
    const element = button(chordLabel(chord), 'grip-button', () => {
      known = known.includes(chord) ? known.filter(item => item !== chord) : [...known, chord];
      persistGrips();
    });
    element.setAttribute('aria-pressed', String(known.includes(chord)));
    element.setAttribute('aria-label', `${chordLabel(chord)} kann ich`);
    $(music.OPEN_CHORDS.includes(chord) ? '#known-grips' : '#more-grips').append(element);
  });
  $('#grips-message').textContent = preferenceError ? 'Deine Auswahl gilt für diese Sitzung. Der Browser konnte sie nicht dauerhaft speichern.' : known.length ? `${known.length} Griffe ausgewählt · auf diesem Gerät gespeichert` : 'Wähle die Griffe aus, die du bereits kannst.';
}
function persistGrips() {
  try { localStorage.setItem('chordsnap-known-grips', JSON.stringify(known)); preferenceError = false; }
  catch { preferenceError = true; }
  renderGrips(); updateCapo(); renderLearning(); renderCollection();
}
function renderLearning() {
  learningRecommendation = music.recommendChord(songs, known);
  $('#learn-button').hidden = !learningRecommendation;
  if (!songs.length) $('#learning-text').textContent = 'Speichere deinen ersten Song. Hier siehst du dann, welcher neue Griff dir in deiner Sammlung am meisten hilft.';
  else if (!known.length) { $('#learning-text').textContent = 'Wähle zuerst deine bekannten Griffe. Dann vergleichen wir sie mit den Akkorden deiner gespeicherten Songs.'; $('#learn-button').hidden = true; }
  else if (!learningRecommendation) $('#learning-text').textContent = 'Für die sicher erkannten Akkorde deiner Sammlung hast du bereits passende Griffe. Unklare Stellen bitte zuerst prüfen.';
  else {
    const { chord, unlocked, helped } = learningRecommendation;
    $('#learning-text').textContent = `Lerne ${chordLabel(chord)} als Nächstes. ${unlocked ? `Damit kannst du die erkannten Akkorde in ${unlocked} weiteren ${unlocked === 1 ? 'Song' : 'Songs'} mit einem passenden Capo vollständig spielen.` : `Dieser Griff verringert die fehlenden Griffe in ${helped} ${helped === 1 ? 'Song' : 'Songs'}.`}`;
    $('#learn-button').textContent = `${chordLabel(chord)} kann ich jetzt`;
  }
}
async function refreshCollection() {
  try { songs = await ChordStore.all(); renderCollection(); renderLearning(); }
  catch { $('#collection-message').textContent = 'Die lokale Sammlung ist hier nicht verfügbar. Aufnahme und Analyse funktionieren weiterhin.'; }
}
function renderCollection() {
  const list = $('#song-list'); list.replaceChildren();
  $('#song-count').textContent = `${songs.length} ${songs.length === 1 ? 'Song' : 'Songs'}`;
  if (!songs.length) { const p = document.createElement('p'); p.className = 'empty-collection'; p.textContent = 'Noch ganz viel Platz für deine Musik. Analysiere einen Ausschnitt und speichere deinen ersten Song.'; list.append(p); return; }
  [...songs].sort((a, b) => b.updatedAt - a.updatedAt).forEach(song => {
    const article = document.createElement('article'); article.className = 'song-card';
    const title = document.createElement('h3'); title.textContent = song.name;
    const info = document.createElement('p'); info.className = 'small-note';
    const option = music.capoOptions(song.segments, known)[0];
    info.textContent = `${timeLabel(song.duration)} · ${new Date(song.updatedAt).toLocaleDateString('de-DE')}${known.length && option.total ? ` · ${option.playable}/${option.total} Griffe passen` : ''}`;
    const chords = document.createElement('p'); chords.className = 'song-chords'; chords.textContent = [...new Set(song.segments.filter(s => !s.uncertain).map(s => chordLabel(s.chord)))].join(' · ') || 'Noch unklare Akkorde';
    const actions = document.createElement('div'); actions.className = 'song-actions';
    actions.append(button('Öffnen', 'secondary-button', () => {
      if (busy || recording || !allowReplace()) return;
      loadAudio(song.audio, song.name, song);
      setState('success', 'Song geöffnet.', 'Du kannst direkt mitspielen oder deine Akkorde weiter bearbeiten.');
      $('#playback-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    actions.append(button('Backup laden', 'text-button', () => exportSong(song)));
    actions.append(button('Löschen', 'text-button danger', async () => {
      if (!window.confirm(`„${song.name}“ mit Aufnahme und Akkorden von diesem Gerät löschen?`)) return;
      try { await ChordStore.remove(song.id); if (songId === song.id) { songId = null; markDirty(); } await refreshCollection(); }
      catch { $('#collection-message').textContent = 'Der Song konnte nicht gelöscht werden. Bitte versuche es erneut.'; }
    }));
    actions.querySelectorAll('button').forEach(element => { element.disabled = busy || recording; });
    article.append(title, info, chords, actions); list.append(article);
  });
}
async function saveSong() {
  if (busy || recording || !currentBlob || !segments.length) return;
  const name = $('#song-name').value.trim();
  if (!name) { $('#save-message').textContent = 'Gib deinem Song zuerst einen Namen.'; $('#song-name').focus(); return; }
  const id = songId || crypto.randomUUID();
  $('#save-song').disabled = true;
  try {
    await ChordStore.put({ id, name, audio: currentBlob, duration, segments: structuredClone(segments), capo, capoMode, updatedAt: Date.now() });
    songId = id; dirty = false;
    $('#save-message').textContent = 'Gespeichert. Du findest den Ausschnitt unter „Meine Songs“.';
    await refreshCollection();
  } catch (error) { $('#save-message').textContent = error?.name === 'QuotaExceededError' ? 'Der Gerätespeicher ist voll. Lade ein Backup und lösche danach ältere Songs.' : 'Speichern nicht möglich. Lass diese Seite offen, damit deine Aufnahme erhalten bleibt.'; }
  finally { $('#save-song').disabled = false; }
}
async function exportSong(song) {
  try {
    const audio = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(song.audio); });
    const backup = { version: 1, song: { ...song, audio } };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `${song.name.replace(/[^\p{L}\p{N} -]/gu, '').trim() || 'Song'}-chordsnap.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch { $('#collection-message').textContent = 'Das Backup konnte nicht erstellt werden. Bitte versuche es erneut.'; }
}
async function importBackup(file) {
  if (!file || busy || recording || !allowReplace()) return;
  if (file.size > 32 * 1024 * 1024) { $('#collection-message').textContent = 'Das Backup ist zu groß (maximal 32 MB).'; return; }
  setBusy(true);
  try {
    const data = JSON.parse(await file.text()); const song = data.song;
    if (data.version !== 1 || !song || typeof song.name !== 'string' || !Number.isFinite(song.duration) || song.duration < 0.5 || song.duration > 60.05 || !Array.isArray(song.segments) || !song.segments.length || song.segments.length > 1500 || typeof song.audio !== 'string' || !/^data:audio\/[\w.+-]+(?:;[^,]*)?;base64,[A-Za-z0-9+/=]+$/.test(song.audio)) throw new Error('Ungültiges Song-Backup.');
    let end = 0;
    const validated = song.segments.map(segment => {
      if (!Number.isFinite(segment.time) || !Number.isFinite(segment.end) || segment.time < end - 0.001 || segment.end <= segment.time || segment.end > song.duration + 0.001) throw new Error('Ungültige Akkordzeiten.');
      end = segment.end;
      const chord = music.normalizeChord(segment.chord);
      return { chord, time: segment.time, end: segment.end, strength: Number.isFinite(segment.strength) ? segment.strength : 0, uncertain: chord === '?' || Boolean(segment.uncertain), silent: chord === '?' && Boolean(segment.silent), corrected: Boolean(segment.corrected), candidates: Array.isArray(segment.candidates) ? segment.candidates.map(music.normalizeChord).filter(c => c !== '?').slice(0, 2) : [] };
    });
    const raw = atob(song.audio.slice(song.audio.indexOf(',') + 1));
    const blob = new Blob([Uint8Array.from(raw, char => char.charCodeAt(0))], { type: song.audio.slice(5, song.audio.indexOf(';')) });
    const imported = { segments: validated, duration: song.duration, capo: Number.isInteger(song.capo) && song.capo >= 0 && song.capo <= 7 ? song.capo : 0, capoMode: ['original', 'personal', 'manual'].includes(song.capoMode) ? song.capoMode : 'original' };
    loadAudio(blob, song.name.slice(0, 80), imported); markDirty();
    $('#collection-message').textContent = 'Backup geöffnet. Mit „Song speichern“ legst du es in deiner Sammlung ab.';
    $('#result-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) { $('#collection-message').textContent = `Backup konnte nicht geöffnet werden. ${error instanceof SyntaxError ? 'Die Datei ist kein gültiges JSON.' : error.message}`; }
  finally { setBusy(false); $('#backup-file').value = ''; }
}

$('#record-button').addEventListener('click', startRecording);
$('#stop-button').addEventListener('click', stopRecording);
$('#analyze-button').addEventListener('click', analyzeRecording);
$('#demo-button').addEventListener('click', () => {
  if (busy || recording || !allowReplace()) return;
  loadAudio(new Blob([ChordDemo.wav(ChordDemo.signal())], { type: 'audio/wav' }), 'Testfolge C–G–Am–F');
  setState('success', 'Testaufnahme geladen.', 'Erzeugte Dreiklänge: C–G–Am–F, je zwei Sekunden. Starte jetzt die echte Akkorderkennung.');
});
$('#audio-file').addEventListener('change', event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file || busy || recording || !allowReplace()) return;
  if (file.size > 20 * 1024 * 1024) { setState('warning', 'Die Audiodatei ist zu groß.', 'Bitte verwende einen Ausschnitt bis 60 Sekunden und 20 MB.'); return; }
  loadAudio(file, file.name.replace(/\.[^.]+$/, '').slice(0, 80));
  setState('success', 'Audiodatei geöffnet.', 'Du kannst sie anhören und anschließend die Akkorde erkennen lassen.');
});
$('#play-button').addEventListener('click', () => {
  previewEnd = null;
  if (!audioPlayer.paused) audioPlayer.pause();
  else { if (loop && (audioPlayer.currentTime < loop.start || audioPlayer.currentTime >= loop.end)) audioPlayer.currentTime = loop.start; playAudio(); }
});
audioPlayer.addEventListener('loadedmetadata', () => {
  if (Number.isFinite(audioPlayer.duration)) { duration = audioPlayer.duration; $('#duration-label').textContent = timeLabel(duration); }
});
audioPlayer.addEventListener('play', () => { stopVoices(); $('#play-button').textContent = 'Pause'; cancelAnimationFrame(renderFrame); playbackTick(); });
audioPlayer.addEventListener('pause', () => { $('#play-button').textContent = 'Mitspielen'; cancelAnimationFrame(renderFrame); updatePlayback(); });
audioPlayer.addEventListener('timeupdate', updatePlayback);
audioPlayer.addEventListener('seeking', updatePlayback);
audioPlayer.addEventListener('ended', () => { if (loop) { audioPlayer.currentTime = loop.start; playAudio(); } });
$('#playback-rate').addEventListener('change', event => { audioPlayer.playbackRate = Number(event.target.value); audioPlayer.preservesPitch = true; });
document.querySelectorAll('[name="capo-mode"]').forEach(input => input.addEventListener('change', () => { capoMode = input.value; updateCapo(); if (segments.length) markDirty(); }));
$('#capo-select').addEventListener('change', event => {
  capo = Number(event.target.value); capoMode = 'manual'; document.querySelectorAll('[name="capo-mode"]').forEach(input => { input.checked = false; }); updateCapo(); markDirty();
});
$('#close-editor').addEventListener('click', () => { $('#editor').hidden = true; });
$('#apply-correction').addEventListener('click', applyCorrection);
$('#preview-correction').addEventListener('click', () => previewChord($('#chord-correction').value));
$('#listen-segment').addEventListener('click', () => { if (selected < 0) return; resetLoop(); audioPlayer.currentTime = segments[selected].time; previewEnd = segments[selected].end; playAudio(); });
$('#reset-correction').addEventListener('click', () => {
  if (!segments[selected]?.original) return;
  Object.assign(segments[selected], segments[selected].original); delete segments[selected].original; delete segments[selected].corrected;
  markDirty(); updateCapo(); selectSegment(selected); updateAnalysisNote();
});
$('#loop-toggle').addEventListener('click', toggleLoop);
['#loop-start', '#loop-end'].forEach(selector => $(selector).addEventListener('input', () => { resetLoop(); $('#loop-message').textContent = 'Neue Zeiten mit „Schleife einschalten“ übernehmen.'; }));
$('#loop-selection').addEventListener('click', () => {
  const index = selected >= 0 ? selected : Math.max(0, music.activeIndex(segments, audioPlayer.currentTime));
  if (!segments[index]) return;
  resetLoop(); $('#loop-start').value = segments[index].time.toFixed(2); $('#loop-end').value = Math.min(duration, (segments[index + 1] || segments[index]).end).toFixed(2);
  $('#loop-message').textContent = 'Der gewählte Akkord und der nächste sind ausgewählt. Schalte die Schleife ein.';
});
$('#save-song').addEventListener('click', saveSong);
$('#song-name').addEventListener('input', markDirty);
$('#learn-button').addEventListener('click', () => { if (learningRecommendation && !known.includes(learningRecommendation.chord)) { known.push(learningRecommendation.chord); persistGrips(); } });
$('#backup-file').addEventListener('change', event => importBackup(event.target.files[0]));
window.addEventListener('beforeunload', event => { if (dirty || recording) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { if (recording) stopRecording(); cleanupMicrophone(); audioPlayer.pause(); stopVoices(); });
$('#chord-correction').append(new Option('Unklar (?)', '?'), ...music.CHORDS.map(chord => new Option(chordLabel(chord), chord)));
renderGrips(); refreshCollection();
