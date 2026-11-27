import { normalizeRecord } from "../public/record.js";
import { mediaLimitsLabel, mediaMaxBytes, singleUploadMaxBytes, uploadPartBytes } from "../public/media.js";
import { b2Album } from "./b2-album.js";

const sessionAge = 180 * 24 * 60 * 60;
const inviteAge = 24 * 60 * 60 * 1000;
const maxBodyBytes = 64 * 1024;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const mediaId = new RegExp("^\\d{13}-" + uuid.source.slice(1, -1) + "(?:-m)?$", "i");
const albumRoute = /^\/api\/album(?:\/([^/]+))?$/;
const uploadLifetime = 7 * 24 * 60 * 60 * 1000;
const singleUploadLease = 15 * 60 * 1000;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function error(status, code, message) {
  throw new ApiError(status, code, message);
}

function json(value, status = 200, cookie) {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return Response.json(value, { status, headers });
}

function randomKey(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function matchesSetupKey(input, secret) {
  if (typeof secret !== "string" || secret.length < 32 || typeof input !== "string") return false;
  const [provided, expected] = await Promise.all([digest(input), digest(secret)]);
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function validKey(value, digits) {
  return typeof value === "string" && value.length === digits && /^[a-f\d]+$/i.test(value);
}

function statement(db, sql, ...bindings) {
  return db.prepare(sql).bind(...bindings);
}

function sessionCookie(url, token, maxAge = sessionAge) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return "doi_session=" + token + "; Max-Age=" + maxAge + "; Path=/; HttpOnly; SameSite=Strict" + secure;
}

async function currentSession(request, db) {
  const match = /(?:^|;\s*)doi_session=([a-f\d]{64})(?=;|$)/.exec(request.headers.get("Cookie") ?? "");
  if (!match) return null;
  return statement(db, "SELECT token_hash, account_id FROM sessions WHERE token_hash = ? AND expires_at > ?",
    await digest(match[1]), Date.now()).first();
}

async function readBody(request) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") ||
      Number(request.headers.get("Content-Length") ?? 0) > maxBodyBytes || !request.body) {
    error(400, "body", "请求内容无效或过大。");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => {});
        error(413, "body", "这条记录内容过长。");
      }
      text += decoder.decode(value, { stream: true });
    }
    const result = JSON.parse(text + decoder.decode());
    if (result && typeof result === "object" && !Array.isArray(result)) return result;
  } catch (failure) {
    if (failure instanceof ApiError) throw failure;
  }
  error(400, "body", "无法读取请求内容。");
}

async function profile(db, accountId) {
  if (!accountId) return { accountId: null, space: null };
  const row = await statement(db, `
    SELECT m.space_id, (SELECT count(*) FROM members WHERE space_id = m.space_id) AS participants
    FROM members AS m JOIN spaces AS s ON s.id = m.space_id
    WHERE m.account_id = ? AND s.closed = 0
  `, accountId).first();
  return { accountId, space: row ? { id: row.space_id, paired: row.participants === 2 } : null };
}

async function issueSession(db, accountId) {
  const token = randomKey(32);
  await statement(db, "INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)",
    await digest(token), accountId, Date.now() + sessionAge * 1000).run();
  return token;
}

async function newIdentity(db, inviteHash = null) {
  const accountId = crypto.randomUUID();
  const newSpaceId = crypto.randomUUID();
  const recoveryCode = randomKey(32);
  const token = randomKey(32);
  const [recoveryHash, tokenHash] = await Promise.all([digest(recoveryCode), digest(token)]);
  const now = Date.now();
  const commands = [];
  if (inviteHash) {
    commands.push(
      statement(db, `
        INSERT INTO accounts (id, recovery_hash)
        SELECT ?, ? FROM invites i JOIN spaces s ON s.id = i.space_id
        WHERE i.code_hash = ? AND i.expires_at > ? AND s.closed = 0
          AND (SELECT count(*) FROM members WHERE space_id = i.space_id) = 1
      `, accountId, recoveryHash, inviteHash, now),
      statement(db, `
        INSERT INTO members (account_id, space_id)
        SELECT a.id, i.space_id FROM accounts a JOIN invites i ON i.code_hash = ? WHERE a.id = ?
      `, inviteHash, accountId),
    );
  } else {
    commands.push(
      statement(db, `
        INSERT INTO accounts (id, recovery_hash) SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM accounts)
      `, accountId, recoveryHash),
      statement(db, "INSERT INTO spaces (id) SELECT ? FROM accounts WHERE id = ?", newSpaceId, accountId),
      statement(db, "INSERT INTO members (account_id, space_id) SELECT id, ? FROM accounts WHERE id = ?", newSpaceId, accountId),
    );
  }
  commands.push(statement(db, `
    INSERT INTO sessions (token_hash, account_id, expires_at)
    SELECT ?, account_id, ? FROM members WHERE account_id = ?
  `, tokenHash, now + sessionAge * 1000, accountId));
  const [created] = await db.batch(commands);
  if (!created.meta.changes) {
    if (inviteHash) error(409, "invite", "邀请码已使用、过期或无效。");
    error(409, "initialised", "已经开通过情侣空间。请使用邀请码或恢复码。");
  }
  return { accountId, recoveryCode, token };
}

async function acceptInvite(db, inviteCode, accountId, url) {
  if (!validKey(inviteCode, 32)) error(400, "invite", "请填写完整的邀请码。");
  const inviteHash = await digest(inviteCode.toLowerCase());
  if (!accountId) {
    const identity = await newIdentity(db, inviteHash);
    return json({ profile: await profile(db, identity.accountId), recoveryCode: identity.recoveryCode }, 201,
      sessionCookie(url, identity.token));
  }
  const result = await statement(db, `
    INSERT INTO members (account_id, space_id)
    SELECT ?, i.space_id FROM invites i JOIN spaces s ON s.id = i.space_id
    WHERE i.code_hash = ? AND i.expires_at > ? AND s.closed = 0
      AND (SELECT count(*) FROM members WHERE space_id = i.space_id) = 1
      AND NOT EXISTS (SELECT 1 FROM members WHERE account_id = ?)
  `, accountId, inviteHash, Date.now(), accountId).run();
  if (!result.meta.changes) error(409, "invite", "邀请码已失效，或此账号已经加入空间。");
  return json({ profile: await profile(db, accountId) });
}

function pairedSpace(current, spaceId) {
  if (!current.space?.paired || current.space.id !== spaceId) {
    error(403, "membership", "这个情侣空间当前不可访问。");
  }
  return spaceId;
}

const authorizedPair = `EXISTS (
  SELECT 1 FROM members m JOIN spaces s ON s.id = m.space_id
  WHERE m.space_id = ? AND m.account_id = ? AND s.closed = 0
    AND (SELECT count(*) FROM members WHERE space_id = m.space_id) = 2
)`;

function sharedRecord(row) {
  const record = row.record_json === null ? null : JSON.parse(row.record_json);
  return { ...(record ?? {}), id: row.id, version: row.version, authorId: row.author_id, deleted: record === null };
}

async function changes(db, accountId, spaceId, cursor) {
  const { results } = await statement(db, `
    SELECT c.seq, r.id, r.author_id, r.version, r.record_json
    FROM shared_changes c
    JOIN shared_records r ON r.space_id = c.space_id AND r.id = c.record_id
    WHERE c.space_id = ? AND c.seq > ? AND ${authorizedPair}
    ORDER BY c.seq LIMIT 80
  `, spaceId, cursor, spaceId, accountId).all();
  return json({
    records: results.map(sharedRecord),
    cursor: results.at(-1)?.seq ?? cursor,
    more: results.length === 80,
  });
}

async function mutateRecord(db, body, accountId, spaceId) {
  const { id, opId, kind, expectedVersion } = body;
  if (typeof id !== "string" || typeof opId !== "string" || !uuid.test(id) || !uuid.test(opId) ||
      !["create", "update", "delete"].includes(kind) || !Number.isSafeInteger(expectedVersion) ||
      (kind === "create" ? expectedVersion !== 0 : expectedVersion < 1)) {
    error(400, "operation", "同步操作格式无效。");
  }
  let recordJson = null;
  if (kind !== "delete") {
    try {
      const record = normalizeRecord(body.record);
      if (record.id !== id) error(400, "record", "记录 ID 不匹配。");
      recordJson = JSON.stringify(record);
    } catch {
      error(400, "record", "共享记录格式无效。");
    }
  }

  if (kind === "create") {
    await statement(db, `
      INSERT OR IGNORE INTO shared_records (space_id, id, author_id, version, last_operation, record_json)
      SELECT ?, ?, ?, 1, ?, ? WHERE ${authorizedPair}
    `, spaceId, id, accountId, opId, recordJson, spaceId, accountId).run();
  } else {
    await statement(db, `
      UPDATE shared_records SET version = version + 1, last_operation = ?, record_json = ?
      WHERE space_id = ? AND id = ? AND author_id = ? AND version = ?
        AND record_json IS NOT NULL AND ${authorizedPair}
    `, opId, recordJson, spaceId, id, accountId, expectedVersion, spaceId, accountId).run();
  }

  const row = await statement(db, `
    SELECT id, author_id, version, last_operation, record_json FROM shared_records
    WHERE space_id = ? AND id = ? AND ${authorizedPair}
  `, spaceId, id, spaceId, accountId).first();
  if (row?.author_id === accountId && row.last_operation === opId) return json({ record: sharedRecord(row) });
  if (row && row.author_id !== accountId) error(403, "author", "只有记录的发布者可以修改或删除。");
  const latest = await profile(db, accountId);
  pairedSpace(latest, spaceId);
  error(409, "revision", "这条记录在另一台设备上有变更。");
}

function albumItem(object) {
  return {
    id: object.key.split("/").at(-1),
    name: decodeURIComponent(object.customMetadata.name),
    type: object.customMetadata.type,
    authorId: object.customMetadata.authorId,
    createdAt: object.uploaded.toISOString(),
  };
}

async function writeMediaBody(request, size, write) {
  if (!request.body) error(400, "media", "无法读取所选文件。");
  const length = request.headers.get("Content-Length");
  if (length !== null) {
    if (Number(length) !== size) error(400, "size", "文件大小与上传请求不符。");
    return write(request.body);
  }

  // Cloud storage uploads require a known stream length.
  const stream = new FixedLengthStream(size);
  const controller = new AbortController();
  const transfer = request.body.pipeTo(stream.writable, { signal: controller.signal }).then(
    () => null, (failure) => failure,
  );
  try {
    const object = await write(stream.readable);
    if (object) {
      const failure = await transfer;
      if (failure) throw failure;
    }
    return object;
  } finally {
    controller.abort();
  }
}

function requestedRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const length = Math.min(Number(match[2]), size);
    return length ? { offset: size - length, length } : null;
  }
  const offset = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return offset <= end ? { offset, length: end - offset + 1 } : null;
}

async function readMedia(bucket, key, request) {
  const rangeHeader = request.method === "GET" ? request.headers.get("Range") : null;
  const info = request.method === "HEAD" || rangeHeader ? await bucket.head(key) : null;
  if ((request.method === "HEAD" || rangeHeader) && !info) error(404, "media", "这个文件已不存在。");

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  let range;
  const ifRange = request.headers.get("If-Range");
  if (rangeHeader && (!ifRange || ifRange === info.httpEtag)) {
    range = requestedRange(rangeHeader, info.size);
    if (!range) {
      headers.set("Content-Range", "bytes */" + info.size);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", "bytes " + range.offset + "-" +
      (range.offset + range.length - 1) + "/" + info.size);
  }
  const object = request.method === "HEAD" ? info : await bucket.get(key, range ? { range } : undefined);
  if (!object) error(404, "media", "这个文件已不存在。");
  headers.set("Content-Type", object.customMetadata.type);
  headers.set("Content-Length", String(range?.length ?? object.size));
  headers.set("ETag", object.httpEtag);
  return new Response(object.body ?? null, { status: range ? 206 : 200, headers });
}

function uploadMetadata(type, size, name, authorId) {
  const maxBytes = mediaMaxBytes(type);
  if (!maxBytes) error(415, "type", "请选择受支持的图片或视频。");
  if (!name || name.length > 180 || !Number.isSafeInteger(size) || size <= 0) {
    error(400, "media", "无法读取所选文件。");
  }
  if (size > maxBytes) error(413, "size", mediaLimitsLabel);
  return { type, name: encodeURIComponent(name), authorId };
}

function verifyUploadedObject(object, size, metadata) {
  if (!object || object.size !== size || object.customMetadata.authorId !== metadata.authorId ||
      object.customMetadata.name !== metadata.name || object.customMetadata.type !== metadata.type) {
    error(409, "upload", "这个上传已发生变化，请重新选择文件。");
  }
}

async function confirmMediaAccess(request, env, spaceId, bucket, storedKey) {
  const session = await currentSession(request, env.DB);
  const latest = await profile(env.DB, session?.account_id);
  if (!latest.space?.paired || latest.space.id !== spaceId) {
    if (storedKey) await bucket.delete(storedKey);
    error(403, "membership", "这个情侣空间当前不可访问。");
  }
}

function pendingMedia(db, spaceId, id) {
  return statement(db, "SELECT * FROM album_uploads WHERE space_id = ? AND id = ?", spaceId, id).first();
}

function removePendingMedia(db, spaceId, id, uploadId) {
  return statement(db, "DELETE FROM album_uploads WHERE space_id = ? AND id = ? AND upload_id = ?",
    spaceId, id, uploadId).run();
}

function checksumOptions(bucket, request, size) {
  if (!bucket.requiresChecksum) return undefined;
  const checksum = request.headers.get("X-DoI-Sha1");
  if (!checksum || !/^[a-f\d]{40}$/.test(checksum)) {
    error(400, "checksum", "缺少文件校验值，请关闭并重新打开 DoI 后再上传。");
  }
  return { size, checksum };
}

async function startMediaUpload(request, db, bucket, spaceId, id, key, accountId) {
  const { name, type, size } = await readBody(request);
  const metadata = uploadMetadata(type, size, typeof name === "string" ? name.toWellFormed().trim() : "", accountId);
  if (size <= singleUploadMaxBytes) error(400, "size", "这个文件请使用单次上传。");

  const completed = await bucket.head(key);
  if (completed) {
    verifyUploadedObject(completed, size, metadata);
    return json({ item: albumItem(completed) });
  }

  let pending = await pendingMedia(db, spaceId, id);
  if (!pending) {
    const upload = await bucket.createMultipartUpload(key, { customMetadata: metadata });
    const inserted = await statement(db, `
      INSERT OR IGNORE INTO album_uploads (space_id, id, author_id, upload_id, size, name, type, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${authorizedPair}
    `, spaceId, id, accountId, upload.uploadId, size, metadata.name, type, Date.now(), spaceId, accountId).run();
    if (inserted.meta.changes) {
      // A concurrent request may have finished between our first two lookups.
      const existing = await bucket.head(key);
      if (!existing) return json({ ready: true }, 201);
      await upload.abort();
      await removePendingMedia(db, spaceId, id, upload.uploadId);
      verifyUploadedObject(existing, size, metadata);
      return json({ item: albumItem(existing) });
    }
    await upload.abort();
    pending = await pendingMedia(db, spaceId, id);
    if (!pending) {
      const existing = await bucket.head(key);
      if (existing) {
        verifyUploadedObject(existing, size, metadata);
        return json({ item: albumItem(existing) });
      }
      pairedSpace(await profile(db, accountId), spaceId);
      error(409, "uploadExpired", "这次上传已结束，请重新上传。");
    }
  }
  if (pending.author_id !== accountId || pending.size !== size ||
      pending.name !== metadata.name || pending.type !== type) {
    error(409, "upload", "这个上传已发生变化，请重新选择文件。");
  }
  if (Date.now() - pending.created_at >= uploadLifetime) {
    error(409, "uploadExpired", "这次上传已过期，请重新上传。");
  }
  return json({ ready: true });
}

async function handleMultipart(request, url, id, key, env, bucket, accountId, spaceId, action) {
  if (request.method !== "POST") error(405, "method", "请求方法无效。");
  if (!id.endsWith("-m")) error(404, "media", "这次上传已不存在。");
  if (action === "start") return startMediaUpload(request, env.DB, bucket, spaceId, id, key, accountId);

  const { DB: db } = env;
  if (action === "finish") {
    const existing = await bucket.head(key);
    if (existing?.customMetadata.authorId === accountId) return json({ item: albumItem(existing) });
  }

  const pending = await pendingMedia(db, spaceId, id);
  if (!pending && action === "cancel") return json({ cancelled: true });
  if (!pending) error(409, "uploadExpired", "这次上传已结束，请重新上传。");
  if (pending.author_id !== accountId) error(403, "author", "只有上传者可以操作这次上传。");
  const upload = bucket.resumeMultipartUpload(key, pending.upload_id);
  if (action === "cancel") {
    if (bucket.needsExpiredAbort || Date.now() - pending.created_at < uploadLifetime) await upload.abort();
    await removePendingMedia(db, spaceId, id, pending.upload_id);
    return json({ cancelled: true });
  }
  if (Date.now() - pending.created_at >= uploadLifetime) {
    error(409, "uploadExpired", "这次上传已过期，请重新上传。");
  }

  const partCount = Math.ceil(pending.size / uploadPartBytes);
  if (action === "part") {
    const partNumber = Number(url.searchParams.get("part"));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
      error(400, "part", "视频分片编号无效。");
    }
    const size = Math.min(uploadPartBytes, pending.size - (partNumber - 1) * uploadPartBytes);
    const options = checksumOptions(bucket, request, size);
    const part = await writeMediaBody(request, size, (body) => upload.uploadPart(partNumber, body, options));
    return json({ part });
  }

  const { parts } = await readBody(request);
  if (!Array.isArray(parts) || parts.length !== partCount || parts.some((part, index) =>
    part?.partNumber !== index + 1 || typeof part.etag !== "string" || !part.etag || part.etag.length > 512)) {
    error(400, "part", "视频分片不完整，请继续上传。");
  }
  let object;
  try {
    object = await upload.complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
  } catch (failure) {
    // Retrying after a lost response can race with the original completion.
    const existing = await bucket.head(key);
    if (existing?.customMetadata.authorId === accountId) return json({ item: albumItem(existing) });
    throw failure;
  }
  await confirmMediaAccess(request, env, spaceId, bucket, key);
  await removePendingMedia(db, spaceId, id, pending.upload_id);
  verifyUploadedObject(object, pending.size, { authorId: accountId, name: pending.name, type: pending.type });
  return json({ item: albumItem(object) }, 201);
}

async function uploadSingleMedia(request, env, bucket, spaceId, id, key, size, customMetadata) {
  const { DB: db } = env;
  const { authorId, name, type } = customMetadata;
  const existing = await bucket.head(key);
  if (existing) {
    verifyUploadedObject(existing, size, customMetadata);
    await confirmMediaAccess(request, env, spaceId, bucket);
    return json({ item: albumItem(existing) });
  }
  const options = {
    onlyIf: { etagDoesNotMatch: "*" }, customMetadata, ...checksumOptions(bucket, request, size),
  };
  // B2 creates a new version on every write. Serialize retries for the same album item.
  const lease = crypto.randomUUID();
  const now = Date.now();
  const reserved = await statement(db, `
    INSERT INTO album_uploads (space_id, id, author_id, upload_id, size, name, type, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${authorizedPair}
    ON CONFLICT (space_id, id) DO UPDATE SET upload_id = excluded.upload_id, created_at = excluded.created_at
    WHERE album_uploads.created_at < ? AND album_uploads.author_id = excluded.author_id
      AND album_uploads.size = excluded.size AND album_uploads.name = excluded.name AND album_uploads.type = excluded.type
  `, spaceId, id, authorId, lease, size, name, type, now, spaceId, authorId, now - singleUploadLease).run();
  if (!reserved.meta.changes) error(409, "upload", "这次上传正在处理，请稍后重试。");

  try {
    const current = await bucket.head(key);
    const stored = current ? null : await writeMediaBody(request, size, (body) => bucket.put(key, body, options));
    const object = stored ?? current ?? await bucket.head(key);
    verifyUploadedObject(object, size, customMetadata);
    await confirmMediaAccess(request, env, spaceId, bucket, stored ? key : null);
    return json({ item: albumItem(object) }, stored ? 201 : 200);
  } finally {
    await removePendingMedia(db, spaceId, id, lease);
  }
}

async function handleAlbum(request, url, id, env, accountId, current) {
  const spaceId = pairedSpace(current, url.searchParams.get("space"));
  const bucket = b2Album(env) ?? env.ALBUM;
  if (!bucket) error(503, "albumBinding", "共享相册的存储服务还未配置。");
  const prefix = spaceId + "/";
  const method = request.method;
  if (method === "GET" && !id) {
    const cursor = url.searchParams.get("cursor");
    const page = await bucket.list({ prefix, limit: 24, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
    return json({ items: page.objects.map(albumItem), cursor: page.truncated ? page.cursor : null });
  }
  if (!id || !mediaId.test(id)) error(404, "media", "这个文件已不存在。");
  const key = prefix + id;
  const action = url.searchParams.get("action");
  if (action !== null) {
    if (!["start", "part", "finish", "cancel"].includes(action)) error(404, "route", "接口不存在。");
    return handleMultipart(request, url, id, key, env, bucket, accountId, spaceId, action);
  }
  if (method === "GET" || method === "HEAD") return readMedia(bucket, key, request);

  if (method === "DELETE") {
    const object = await bucket.head(key);
    if (!object) return json({ removed: true });
    if (object.customMetadata.authorId !== accountId) error(403, "author", "只有上传者可以删除这个文件。");
    await bucket.delete(key);
    return json({ removed: true });
  }
  if (method !== "POST") error(405, "method", "请求方法无效。");

  const type = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  const size = Number(url.searchParams.get("size"));
  let name;
  try {
    name = decodeURIComponent(request.headers.get("X-DoI-Filename") ?? "").trim();
  } catch {
    error(400, "media", "无法读取所选文件名。");
  }
  const customMetadata = uploadMetadata(type, size, name, accountId);
  if (size > singleUploadMaxBytes || id.endsWith("-m")) {
    error(413, "multipart", "大视频需要分片上传，请更新应用后重试。");
  }

  return uploadSingleMedia(request, env, bucket, spaceId, id, key, size, customMetadata);
}

export async function handleApi(request, env) {
  try {
    const url = new URL(request.url);
    const route = url.pathname;
    const { DB: db } = env;
    if (!db) error(503, "binding", "同步服务还未配置。");
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      error(403, "https", "同步需要 HTTPS。");
    }
    const album = albumRoute.exec(route);
    const method = request.method;
    if (method !== "GET" && method !== "POST" && !(album && (method === "HEAD" || method === "DELETE"))) {
      error(405, "method", "请求方法无效。");
    }
    if ((method === "POST" || method === "DELETE") && request.headers.get("Origin") !== url.origin) {
      error(403, "origin", "请求来源无效。");
    }

    const session = await currentSession(request, db);
    const accountId = session?.account_id;
    if (album) {
      if (!accountId) error(401, "session", "请登录情侣空间。");
      return await handleAlbum(request, url, album[1], env, accountId, await profile(db, accountId));
    }
    if (request.method === "GET" && route === "/api/profile") return json({ profile: await profile(db, accountId) });
    const data = request.method === "POST" ? await readBody(request) : null;

    if (request.method === "POST" && route === "/api/bootstrap") {
      if (accountId) error(409, "session", "请先退出当前账号。");
      if (!await matchesSetupKey(data.setupCode, env.DOI_SETUP_KEY)) error(403, "setup", "开通码无效或未配置。");
      const identity = await newIdentity(db);
      return json({ profile: await profile(db, identity.accountId), recoveryCode: identity.recoveryCode }, 201,
        sessionCookie(url, identity.token));
    }
    if (request.method === "POST" && route === "/api/join") return await acceptInvite(db, data.inviteCode, accountId, url);
    if (request.method === "POST" && route === "/api/recover") {
      if (accountId) error(409, "session", "请先退出当前账号。");
      if (!validKey(data.recoveryCode, 64)) error(400, "recovery", "请填写完整的恢复码。");
      const row = await statement(db, "SELECT id FROM accounts WHERE recovery_hash = ?",
        await digest(data.recoveryCode.toLowerCase())).first();
      if (!row) error(403, "recovery", "恢复码无效。");
      return json({ profile: await profile(db, row.id) }, 200, sessionCookie(url, await issueSession(db, row.id)));
    }

    if (!accountId) error(401, "session", "请登录情侣空间。");
    const current = await profile(db, accountId);
    if (request.method === "GET" && route === "/api/changes") {
      const spaceId = pairedSpace(current, url.searchParams.get("space"));
      const cursor = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(cursor) || cursor < 0) error(400, "cursor", "同步位置无效。");
      return await changes(db, accountId, spaceId, cursor);
    }
    if (request.method !== "POST") error(404, "route", "接口不存在。");

    switch (route) {
      case "/api/record":
        return await mutateRecord(db, data, accountId, pairedSpace(current, data.spaceId));
      case "/api/invite": {
        if (!current.space || current.space.paired) error(409, "membership", "此空间当前无法邀请。");
        const inviteCode = randomKey(16);
        const expiresAt = Date.now() + inviteAge;
        const result = await statement(db, `
          INSERT INTO invites (code_hash, space_id, expires_at)
          SELECT ?, m.space_id, ? FROM members m JOIN spaces s ON s.id = m.space_id
          WHERE m.account_id = ? AND m.space_id = ? AND s.closed = 0
            AND (SELECT count(*) FROM members WHERE space_id = m.space_id) = 1
          ON CONFLICT (space_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at
        `, await digest(inviteCode), expiresAt, accountId, current.space.id).run();
        if (!result.meta.changes) error(409, "membership", "此空间当前无法邀请。");
        return json({ inviteCode, expiresAt });
      }
      case "/api/recovery": {
        const recoveryCode = randomKey(32);
        await statement(db, "UPDATE accounts SET recovery_hash = ? WHERE id = ?", await digest(recoveryCode), accountId).run();
        return json({ recoveryCode });
      }
      case "/api/new-space": {
        if (current.space) error(409, "membership", "你已有一个情侣空间。");
        const spaceId = crypto.randomUUID();
        await db.batch([
          statement(db, "INSERT INTO spaces (id) VALUES (?)", spaceId),
          statement(db, "INSERT INTO members (account_id, space_id) VALUES (?, ?)", accountId, spaceId),
        ]);
        return json({ profile: await profile(db, accountId) }, 201);
      }
      case "/api/leave": {
        if (!current.space || current.space.id !== data.spaceId) error(403, "membership", "该空间已关闭。");
        const spaceId = current.space.id;
        await db.batch([
          statement(db, `
            UPDATE spaces SET closed = 1 WHERE id = ? AND EXISTS (
              SELECT 1 FROM members WHERE space_id = ? AND account_id = ?
            )
          `, spaceId, spaceId, accountId),
          statement(db, "DELETE FROM invites WHERE space_id = ? AND EXISTS (SELECT 1 FROM spaces WHERE id = ? AND closed = 1)",
            spaceId, spaceId),
          statement(db, "DELETE FROM members WHERE space_id = ? AND EXISTS (SELECT 1 FROM spaces WHERE id = ? AND closed = 1)",
            spaceId, spaceId),
        ]);
        return json({ profile: await profile(db, accountId) });
      }
      case "/api/logout":
        await statement(db, "DELETE FROM sessions WHERE token_hash = ?", session.token_hash).run();
        return json({ profile: { accountId: null, space: null } }, 200, sessionCookie(url, "", 0));
      default:
        error(404, "route", "接口不存在。");
    }
  } catch (failure) {
    if (failure instanceof ApiError) {
      return json({ code: failure.code, message: failure.message }, failure.status);
    }
    return json({ code: "unavailable", message: "暂时无法连接同步服务，请稍后重试。" }, 503);
  }
}
