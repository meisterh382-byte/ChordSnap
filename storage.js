/* User audio is stored only on explicit save, in IndexedDB on this device. */
const ChordStore = (() => {
  let database;
  function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('chordsnap', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('songs', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Bitte schließe andere ChordSnap-Tabs und versuche es erneut.'));
    }).catch(error => { database = null; throw error; });
    return database;
  }
  async function transaction(mode, action) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', mode);
      let request;
      try { request = action(tx.objectStore('songs')); }
      catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error || request.error);
      tx.onabort = () => reject(tx.error || new Error('Speichern wurde abgebrochen.'));
    });
  }
  return {
    all: () => transaction('readonly', store => store.getAll()),
    put: song => transaction('readwrite', store => store.put(song)),
    remove: id => transaction('readwrite', store => store.delete(id)),
  };
})();
