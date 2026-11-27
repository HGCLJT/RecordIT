import { localDay } from "./dates.js";
import { normalizeRecord } from "./record.js";

const databaseName = "doi";
const recordStore = "records";
const settingsStore = "settings";
const profileKey = "profile";
const coupleStore = "couple";

export const databaseEvents = new EventTarget();
let connection;

export class RecordConflict extends Error {
  constructor() {
    super("这条记录已在别处更新。请返回列表后重新打开。");
  }
}

function openDatabase() {
  if (!connection) {
    connection = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 2);

      request.onupgradeneeded = (event) => {
        const database = request.result;
        if (event.oldVersion < 1) {
          const records = database.createObjectStore(recordStore, { keyPath: "id" });
          records.createIndex("byDate", "occurredOn");
          database.createObjectStore(settingsStore, { keyPath: "key" });
        }
        if (event.oldVersion < 2) {
          database.createObjectStore(coupleStore, { keyPath: "key" });
        }
      };
      request.onblocked = () => databaseEvents.dispatchEvent(new Event("blocked"));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          connection = undefined;
          databaseEvents.dispatchEvent(new Event("versionchange"));
        };
        database.onclose = () => { connection = undefined; };
        resolve(database);
      };
    }).catch((error) => {
      connection = undefined;
      throw error;
    });
  }
  return connection;
}

async function transaction(storeName, mode, run) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    let value;
    let failure;
    const setResult = (result) => { value = result; };
    const abort = (error) => {
      failure = error;
      tx.abort();
    };
    tx.oncomplete = () => resolve(value);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("本机存储操作未完成。"));
    try {
      run(tx.objectStore(storeName), setResult, abort);
    } catch (error) {
      abort(error);
    }
  });
}

function requestResult(request, callback) {
  request.onsuccess = () => callback(request.result);
}

export function getRecord(id) {
  return transaction(recordStore, "readonly", (store, result) => requestResult(store.get(id), result));
}

export function getRecords(range) {
  return transaction(recordStore, "readonly", (store, result) => {
    const request = range
      ? store.index("byDate").getAll(IDBKeyRange.bound(range.start, range.end))
      : store.getAll();
    requestResult(request, result);
  });
}

function ensureAllowedDate(record) {
  if (record.occurredOn > localDay()) throw new Error("请选择今天或之前的日期。");
}

export function addRecord(record) {
  const normalized = normalizeRecord(record);
  ensureAllowedDate(normalized);
  return transaction(recordStore, "readwrite", (store, result) => {
    requestResult(store.add(normalized), () => result(normalized));
  });
}

function writeAgainstSnapshot(original, run) {
  return transaction(recordStore, "readwrite", (store, result, abort) => {
    requestResult(store.get(original.id), (current) => {
      if (!current || Object.keys(original).some((key) => original[key] !== current[key])) {
        abort(new RecordConflict());
        return;
      }
      run(store, result);
    });
  });
}

export function updateRecord(original, next) {
  const updatedAt = new Date(Math.max(Date.now(), Date.parse(original.updatedAt) + 1)).toISOString();
  const normalized = normalizeRecord({
    ...next,
    id: original.id,
    createdAt: original.createdAt,
    updatedAt,
  });
  if (normalized.occurredOn !== original.occurredOn) ensureAllowedDate(normalized);
  return writeAgainstSnapshot(original, (store, result) => {
    requestResult(store.put(normalized), () => result(normalized));
  });
}

export function deleteRecord(original) {
  return writeAgainstSnapshot(original, (store) => { store.delete(original.id); });
}

export function getNickname() {
  return transaction(settingsStore, "readonly", (store, result) => {
    requestResult(store.get(profileKey), (profile) => result(profile?.partnerNickname ?? ""));
  });
}

export function saveNickname(value) {
  const nickname = value.trim();
  return transaction(settingsStore, "readwrite", (store, result) => {
    requestResult(store.put({ key: profileKey, partnerNickname: nickname }), () => result(nickname));
  });
}

function selectMissing(records, keys) {
  const known = new Set(keys);
  const pending = [];
  for (const record of records) {
    if (!known.has(record.id)) {
      pending.push(record);
      known.add(record.id);
    }
  }
  return { pending, added: pending.length, skipped: records.length - pending.length };
}

export function previewMerge(records) {
  return transaction(recordStore, "readonly", (store, result) => {
    requestResult(store.getAllKeys(), (keys) => {
      const { added, skipped } = selectMissing(records, keys);
      result({ added, skipped });
    });
  });
}

export function mergeRecords(records) {
  const normalized = records.map(normalizeRecord);
  return transaction(recordStore, "readwrite", (store, result) => {
    requestResult(store.getAllKeys(), (keys) => {
      const { pending, added, skipped } = selectMissing(normalized, keys);
      for (const record of pending) store.add(record);
      result({ added, skipped });
    });
  });
}

export function getCoupleState(key) {
  return transaction(coupleStore, "readonly", (store, result) => {
    requestResult(store.get(key), (entry) => result(entry?.value ?? null));
  });
}

export function setCoupleState(key, value) {
  return transaction(coupleStore, "readwrite", (store) => {
    store.put({ key, value });
  });
}

export function mutateCoupleState(key, transform) {
  return transaction(coupleStore, "readwrite", (store, result, abort) => {
    requestResult(store.get(key), (entry) => {
      try {
        const next = transform(entry?.value ?? null);
        store.put({ key, value: next });
        result(next);
      } catch (error) {
        abort(error);
      }
    });
  });
}
