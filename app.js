const recordButton = document.querySelector('#record-button');
const stopButton = document.querySelector('#stop-button');
const statusText = document.querySelector('#status-text');
const statusDot = document.querySelector('#status-dot');
const message = document.querySelector('#message');
const playbackSection = document.querySelector('#playback-section');
const audioPlayer = document.querySelector('#audio-player');
const analyzeButton = document.querySelector('#analyze-button');
const resultSection = document.querySelector('#result-section');
const chordList = document.querySelector('#chord-list');

let mediaRecorder;
let mediaStream;
let audioChunks = [];
let currentAudioUrl;
let currentAudioBlob;
let essentia;
let essentiaReady;

function setState(type, status, detail) {
  statusDot.classList.remove('success', 'error', 'recording');
  if (type) statusDot.classList.add(type);
  statusText.textContent = status;
  message.textContent = detail;
}

function resetPlayback() {
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  currentAudioBlob = null;
  audioPlayer.removeAttribute('src');
  playbackSection.hidden = true;
  resultSection.hidden = true;
  chordList.innerHTML = '';
}

function loadEssentia() {
  if (essentiaReady) return essentiaReady;
  if (typeof EssentiaWASM !== 'function' || typeof Essentia === 'undefined') {
    return Promise.reject(new Error('Essentia konnte nicht geladen werden.'));
  }

  essentiaReady = EssentiaWASM().then((wasmModule) => {
    essentia = new Essentia(wasmModule);
    return essentia;
  });
  return essentiaReady;
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setState('error', 'Aufnahme nicht verfügbar', 'Dein Browser unterstützt die benötigte Audioaufnahme nicht. Bitte nutze einen aktuellen Browser über HTTPS.');
    return;
  }

  resetPlayback();
  audioChunks = [];
  recordButton.disabled = true;
  stopButton.disabled = true;
  setState(null, 'Mikrofon wird geöffnet …', 'Bestätige gegebenenfalls die Mikrofonberechtigung deines Browsers.');

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream);

    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    });

    mediaRecorder.addEventListener('stop', () => {
      const mimeType = mediaRecorder.mimeType || 'audio/webm';
      currentAudioBlob = new Blob(audioChunks, { type: mimeType });
      currentAudioUrl = URL.createObjectURL(currentAudioBlob);
      audioPlayer.src = currentAudioUrl;
      playbackSection.hidden = false;
      setState('success', 'Aufnahme fertig', 'Du kannst die Aufnahme jetzt anhören oder die Akkorde erkennen lassen.');
      recordButton.disabled = false;
      recordButton.textContent = '🎙️ Neue Aufnahme';
      stopButton.disabled = true;
    });

    mediaRecorder.start();
    recordButton.textContent = '🎙️ Aufnahme läuft …';
    stopButton.disabled = false;
    setState('recording', 'Aufnahme läuft', 'Spiele jetzt einen kurzen Songausschnitt ab und tippe danach auf „Aufnahme stoppen“.');
  } catch (error) {
    recordButton.disabled = false;
    recordButton.textContent = '🎙️ Aufnahme starten';
    stopButton.disabled = true;

    if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
      setState('error', 'Mikrofonzugriff abgelehnt', 'Erlaube ChordSnap den Mikrofonzugriff in den Website-Einstellungen und versuche es erneut.');
    } else if (error?.name === 'NotFoundError') {
      setState('error', 'Kein Mikrofon gefunden', 'Auf diesem Gerät wurde kein verfügbares Mikrofon gefunden.');
    } else {
      setState('error', 'Aufnahme konnte nicht gestartet werden', 'Bitte prüfe deine Browser-Berechtigungen und versuche es erneut.');
    }
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  stopButton.disabled = true;
  mediaRecorder.stop();
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

function collapseChordFrames(chords, strengths, hopSeconds) {
  const result = [];
  let previousChord = null;

  for (let i = 0; i < chords.length; i += 1) {
    const chord = String(chords[i] || '').trim();
    const strength = Number(strengths?.[i] ?? 0);
    if (!chord || chord === 'N') continue;

    const normalizedChord = strength < 0.15 ? '?' : chord;
    if (normalizedChord === previousChord) continue;

    result.push({
      chord: normalizedChord,
      time: i * hopSeconds,
      strength,
    });
    previousChord = normalizedChord;
  }

  return result;
}

function renderChordResults(results) {
  chordList.innerHTML = '';

  if (!results.length) {
    setState('error', 'Keine verlässlichen Akkorde erkannt', 'Versuche eine klarere oder etwas lautere Aufnahme mit einfachen Akkordwechseln.');
    resultSection.hidden = true;
    return;
  }

  chordList.innerHTML = results.map((item) => {
    const time = `${item.time.toFixed(1)}s`;
    const label = item.chord === '?' ? 'unsicher' : item.chord;
    return `<div class="chord-card"><span class="chord-time">${time}</span><strong>${label}</strong></div>`;
  }).join('');

  resultSection.hidden = false;
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function analyzeRecording() {
  if (!currentAudioBlob) {
    setState('error', 'Keine Aufnahme vorhanden', 'Nimm zuerst einen Songausschnitt auf.');
    return;
  }

  analyzeButton.disabled = true;
  analyzeButton.textContent = 'Analysiere …';
  resultSection.hidden = true;
  chordList.innerHTML = '';
  setState(null, 'Analyse läuft …', 'ChordSnap berechnet die Tonhöhenklassen und sucht nach passenden Dur- und Moll-Akkorden.');

  try {
    await loadEssentia();

    const arrayBuffer = await currentAudioBlob.arrayBuffer();
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    const mono = new Float32Array(audioBuffer.length);

    for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
      const data = audioBuffer.getChannelData(channel);
      for (let i = 0; i < data.length; i += 1) {
        mono[i] += data[i] / audioBuffer.numberOfChannels;
      }
    }

    const signal = essentia.arrayToVector(mono);
    const frameSize = 4096;
    const hopSize = 2048;
    const tonal = essentia.TonalExtractor(signal, frameSize, hopSize, 440);
    const chords = tonal.chords_progression || [];
    const strengths = tonal.chords_strength || [];
    const hopSeconds = hopSize / audioBuffer.sampleRate;
    const results = collapseChordFrames(chords, strengths, hopSeconds);

    if (signal?.delete) signal.delete();
    await audioContext.close();

    renderChordResults(results);
    if (results.length) {
      setState('success', 'Akkorde erkannt', `${results.length} Akkordwechsel wurden gefunden. Unsichere Stellen werden als „unsicher“ markiert.`);
    }
  } catch (error) {
    console.error(error);
    setState('error', 'Analyse fehlgeschlagen', 'Die Aufnahme konnte nicht zuverlässig analysiert werden. Bitte versuche es erneut oder nutze einen anderen Browser.');
    resultSection.hidden = true;
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.textContent = '✨ Akkorde erneut erkennen';
  }
}

recordButton.addEventListener('click', startRecording);
stopButton.addEventListener('click', stopRecording);
analyzeButton.addEventListener('click', analyzeRecording);
