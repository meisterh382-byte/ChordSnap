const button = document.querySelector('#request-mic');
const statusText = document.querySelector('#status-text');
const statusDot = document.querySelector('#status-dot');
const message = document.querySelector('#message');

function setState(type, status, detail) {
  statusDot.classList.remove('success', 'error');
  if (type) statusDot.classList.add(type);
  statusText.textContent = status;
  message.textContent = detail;
}

async function requestMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setState(
      'error',
      'Mikrofonzugriff nicht verfügbar',
      'Dein Browser unterstützt den benötigten Mikrofonzugriff nicht. Bitte nutze einen aktuellen Browser und öffne die App über eine sichere HTTPS-Verbindung.'
    );
    return;
  }

  button.disabled = true;
  button.textContent = 'Berechtigung wird angefragt …';
  message.textContent = 'Bestätige bitte die Mikrofonanfrage deines Browsers.';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());

    setState(
      'success',
      'Mikrofon ist freigegeben',
      'Perfekt. ChordSnap darf dein Mikrofon verwenden. Es wurde noch nichts aufgenommen oder gespeichert.'
    );
    button.textContent = 'Mikrofon erneut prüfen';
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
      setState(
        'error',
        'Mikrofonzugriff wurde abgelehnt',
        'Erlaube ChordSnap den Mikrofonzugriff in den Website-Einstellungen deines Browsers und versuche es danach erneut.'
      );
    } else if (error?.name === 'NotFoundError') {
      setState(
        'error',
        'Kein Mikrofon gefunden',
        'Auf diesem Gerät wurde kein verfügbares Mikrofon gefunden.'
      );
    } else {
      setState(
        'error',
        'Mikrofon konnte nicht geöffnet werden',
        'Bitte prüfe die Browser-Berechtigungen und versuche es erneut.'
      );
    }
    button.textContent = 'Erneut versuchen';
  } finally {
    button.disabled = false;
  }
}

button.addEventListener('click', requestMicrophone);
