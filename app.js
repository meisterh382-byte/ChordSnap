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
  audioPlayer.removeAttribute('src');
  playbackSection.hidden = true;
  resultSection.hidden = true;
  chordList.innerHTML = '';
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
      const blob = new Blob(audioChunks, { type: mimeType });
      currentAudioUrl = URL.createObjectURL(blob);
      audioPlayer.src = currentAudioUrl;
      playbackSection.hidden = false;
      setState('success', 'Aufnahme fertig', 'Du kannst die Aufnahme jetzt anhören oder den Analyse-Prototyp testen.');
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

function showPrototypeAnalysis() {
  if (!audioPlayer.src) {
    setState('error', 'Keine Aufnahme vorhanden', 'Nimm zuerst einen Songausschnitt auf.');
    return;
  }

  analyzeButton.disabled = true;
  analyzeButton.textContent = 'Analysiere …';
  setState(null, 'Analyse läuft …', 'Für diesen Prototyp wird noch keine echte Musikerkennung ausgeführt.');

  window.setTimeout(() => {
    const demoChords = ['G', 'D', 'Em', 'C'];
    chordList.innerHTML = demoChords.map((chord, index) => `<div class="chord-card"><span class="chord-time">${index * 2}s</span><strong>${chord}</strong></div>`).join('');
    resultSection.hidden = false;
    analyzeButton.disabled = false;
    analyzeButton.textContent = '✨ Analyse erneut testen';
    setState('success', 'Analyse-Ansicht bereit', 'Der komplette Nutzerfluss ist testbar. Die echte Akkorderkennung bauen wir als nächsten technischen Schritt.');
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 700);
}

recordButton.addEventListener('click', startRecording);
stopButton.addEventListener('click', stopRecording);
analyzeButton.addEventListener('click', showPrototypeAnalysis);
