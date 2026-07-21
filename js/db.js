const DB_NAME = 'englishVocabularyDB';
const DB_VERSION = 1;

const STORES = {
  words: { keyPath: 'id' },
  profile: { keyPath: 'id' },
  settings: { keyPath: 'id' },
  sessions: { keyPath: 'id' },
  meta: { keyPath: 'key' }
};

let dbPromise;

export function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, options] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, options);
          if (name === 'words') {
            store.createIndex('term', 'term', { unique: false });
            store.createIndex('category', 'category', { unique: false });
            store.createIndex('nextReviewAt', 'nextReviewAt', { unique: false });
          }
          if (name === 'sessions') {
            store.createIndex('completedAt', 'completedAt', { unique: false });
          }
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAll(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise(tx.objectStore(storeName).getAll());
}

export async function getOne(storeName, key) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  return requestToPromise(tx.objectStore(storeName).get(key));
}

export async function putOne(storeName, value) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  const result = await requestToPromise(tx.objectStore(storeName).put(value));
  await transactionDone(tx);
  return result;
}

export async function putMany(storeName, values) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const value of values) store.put(value);
  await transactionDone(tx);
}

export async function deleteOne(storeName, key) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await transactionDone(tx);
}

export async function clearStore(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).clear();
  await transactionDone(tx);
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Транзакция отменена'));
  });
}

export async function exportDatabase() {
  const payload = {
    schemaVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    app: 'English Vocabulary',
    data: {}
  };

  for (const storeName of Object.keys(STORES)) {
    payload.data[storeName] = await getAll(storeName);
  }
  return payload;
}

export async function importDatabase(payload) {
  if (!payload || payload.app !== 'English Vocabulary' || !payload.data) {
    throw new Error('Файл не похож на резервную копию English Vocabulary');
  }

  for (const storeName of Object.keys(STORES)) {
    const values = Array.isArray(payload.data[storeName]) ? payload.data[storeName] : [];
    await clearStore(storeName);
    if (values.length) await putMany(storeName, values);
  }
}
