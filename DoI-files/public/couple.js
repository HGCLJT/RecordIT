import { getCoupleState, mutateCoupleState, setCoupleState, mergeRecords } from "./db.js";
import { localDay } from "./dates.js";
import { normalizeRecord } from "./record.js";

const signedOut = { accountId: null, space: null };
const profileKey = "signed-in";
const emptyRoom = () => ({ records: {}, queue: [], cursor: 0 });
export const coupleEvents = new EventTarget();
let currentProfile = signedOut;
let syncPromise;
let accountEpoch = 0;
let lastError = "";
let checked = false;

export class SyncError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function changed(kind) {
  coupleEvents.dispatchEvent(new CustomEvent("change", { detail: kind }));
}

function roomKey(profile) {
  if (!profile.accountId || !profile.space?.paired) return null;
  return "room:" + profile.accountId + ":" + profile.space.id;
}

export function coupleProfile() {
  return currentProfile;
}

export async function coupleSummary() {
  const key = roomKey(currentProfile);
  const room = key ? await getCoupleState(key) : null;
  return { lastError, checked, syncing: Boolean(syncPromise), queue: room?.queue ?? [] };
}

async function request(path, body) {
  let response;
  try {
    response = await fetch("/api/" + path, {
      credentials: "same-origin",
      cache: "no-store",
      signal: typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(12_000) : undefined,
      ...(body === undefined ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
  } catch {
    throw new SyncError("network", "暂时无法连接同步服务。");
  }
  if (!response.headers.get("Content-Type")?.includes("application/json")) {
    throw new SyncError("unavailable", "当前网址还未配置联机服务。");
  }
  const value = await response.json();
  if (!response.ok) throw new SyncError(value.code, value.message);
  return value;
}

async function applyProfile(next) {
  const different = JSON.stringify(next) !== JSON.stringify(currentProfile);
  if (different) {
    await setCoupleState(profileKey, next);
    currentProfile = next;
    changed("profile");
  }
}

export async function initialiseCouple() {
  currentProfile = await getCoupleState(profileKey) ?? signedOut;
  if (currentProfile.accountId) changed("profile");
  return syncCouple();
}

export async function coupleAccountAction(path, fields = {}) {
  accountEpoch += 1;
  // Let any in-flight reconciliation finish before changing the session cookie.
  await syncPromise;
  const response = await request(path, fields);
  if (response.profile) await applyProfile(response.profile);
  checked = true;
  lastError = "";
  changed("status");
  if (response.profile?.space?.paired) void syncCouple();
  return response;
}

function applyRecord(room, record) {
  const previous = room.records[record.id];
  if (!previous || record.version >= previous.version) {
    const { id, version, authorId, deleted } = record;
    room.records[id] = deleted ? { id, version, authorId, deleted } : record;
  }
}

function projectedRecords(room, accountId) {
  const records = { ...room.records };
  for (const op of room.queue) {
    if (op.kind === "delete") {
      delete records[op.id];
    } else {
      records[op.id] = { ...op.record, version: op.expectedVersion + 1, authorId: accountId, deleted: false };
    }
  }
  return Object.values(records).filter((record) => !record.deleted);
}

export async function sharedRecords(range) {
  const profile = currentProfile;
  const key = roomKey(profile);
  if (!key) return [];
  const room = await getCoupleState(key) ?? emptyRoom();
  if (roomKey(currentProfile) !== key) return [];
  const records = projectedRecords(room, profile.accountId);
  return range ? records.filter((record) => record.occurredOn >= range.start && record.occurredOn <= range.end) : records;
}

export async function sharedRecord(id) {
  return (await sharedRecords()).find((record) => record.id === id);
}

function queuedChange(original, kind) {
  const id = original?.id;
  return { id, kind, opId: crypto.randomUUID(), expectedVersion: original?.version ?? 0 };
}

async function enqueue(profile, op, original) {
  const key = roomKey(profile);
  if (!key || key !== roomKey(currentProfile)) {
    throw new Error("情侣空间已发生变化。请重新打开记录。");
  }
  await mutateCoupleState(key, (saved) => {
    const room = saved ?? emptyRoom();
    const record = projectedRecords(room, profile.accountId).find(({ id }) => id === op.id);
    if (room.queue.some((item) => item.id === op.id && item.error)) {
      throw new Error("请先在情侣空间处理这条记录的同步冲突。");
    }
    if (op.kind === "create" ? (record || room.records[op.id]) :
      (!record || record.authorId !== profile.accountId || record.version !== original.version)) {
      throw new Error(op.kind === "create" ? "这条记录已经共享过。" : "记录已发生变化，请重新打开。");
    }
    room.queue.push(op);
    return room;
  });
  changed("records");
  void syncCouple();
}

export function saveSharedRecord(fields, original = null, profile = currentProfile) {
  if ((!original || original.occurredOn !== fields.occurredOn) && fields.occurredOn > localDay()) {
    throw new Error("请选择今天或之前的日期。");
  }
  const op = queuedChange(original, original ? "update" : "create");
  const timestamp = new Date().toISOString();
  op.id = fields.id;
  op.record = normalizeRecord({
    ...fields,
    createdAt: original?.createdAt ?? fields.createdAt,
    updatedAt: timestamp >= fields.createdAt ? timestamp : fields.createdAt,
  });
  if (new TextEncoder().encode(JSON.stringify(op)).byteLength > 63 * 1024) {
    throw new Error("这条记录内容过长，无法共享。");
  }
  return enqueue(profile, op, original);
}

export function deleteSharedRecord(record, profile = currentProfile) {
  return enqueue(profile, queuedChange(record, "delete"), record);
}

export async function resolveConflict(id, keepLocal) {
  const profile = currentProfile;
  const key = roomKey(profile);
  if (!key) throw new Error("情侣空间当前不可访问。");
  const current = await getCoupleState(key);
  const broken = current?.queue.find((item) => item.id === id && item.error);
  if (!broken) return;
  if (keepLocal) {
    const last = current.queue.filter((item) => item.id === id && item.record).at(-1);
    if (last) await mergeRecords([{ ...last.record, id: broken.opId }]);
  }
  await mutateCoupleState(key, (room) => {
    room.queue = room.queue.filter((item) => item.id !== id);
    return room;
  });
  changed("records");
  void syncCouple();
}

async function pushChanges(profile, key, epoch) {
  let updated = false;
  for (let sent = 0; sent < 80 && epoch === accountEpoch; sent++) {
    const room = await getCoupleState(key) ?? emptyRoom();
    const blockedIds = new Set(room.queue.filter(({ error }) => error).map(({ id }) => id));
    const op = room.queue.find(({ id }) => !blockedIds.has(id));
    if (!op) break;
    try {
      const { record } = await request("record", { ...op, spaceId: profile.space.id });
      await mutateCoupleState(key, (stored) => {
        applyRecord(stored, record);
        stored.queue = stored.queue.filter(({ opId }) => opId !== op.opId);
        return stored;
      });
      updated = true;
    } catch (failure) {
      if (!["revision", "author", "operation", "record", "body"].includes(failure.code)) throw failure;
      await mutateCoupleState(key, (stored) => {
        const pending = stored.queue.find(({ opId }) => opId === op.opId);
        if (pending) pending.error = failure.message;
        return stored;
      });
      updated = true;
    }
  }
  return updated;
}

async function pullChanges(profile, key, epoch) {
  let updated = false;
  for (let page = 0; page < 12 && epoch === accountEpoch; page++) {
    const existing = await getCoupleState(key);
    const cursor = existing?.cursor ?? 0;
    const query = new URLSearchParams({ space: profile.space.id, after: cursor });
    const result = await request("changes?" + query);
    if (epoch !== accountEpoch || !result.records.length) break;
    await mutateCoupleState(key, (stored) => {
      const room = stored ?? emptyRoom();
      for (const record of result.records) applyRecord(room, record);
      room.cursor = Math.max(room.cursor, result.cursor);
      return room;
    });
    updated = true;
    if (!result.more) break;
  }
  return updated;
}

export function syncCouple() {
  if (syncPromise) return syncPromise;
  const epoch = accountEpoch;
  syncPromise = (async () => {
    let dataChanged = false;
    try {
      const { profile } = await request("profile");
      if (epoch !== accountEpoch) return;
      await applyProfile(profile);
      checked = true;
      lastError = "";
      const key = roomKey(profile);
      if (key) {
        dataChanged = await pushChanges(profile, key, epoch);
        dataChanged = await pullChanges(profile, key, epoch) || dataChanged;
      }
    } catch (failure) {
      if (epoch !== accountEpoch) return;
      checked = true;
      lastError = failure.message;
      if (["session", "membership"].includes(failure.code)) {
        try {
          const { profile } = await request("profile");
          if (epoch === accountEpoch) await applyProfile(profile);
        } catch {
          // Keep the local copy when the follow-up request cannot reach the server.
        }
      }
    } finally {
      syncPromise = undefined;
      changed(dataChanged ? "records" : "status");
    }
  })();
  return syncPromise;
}
