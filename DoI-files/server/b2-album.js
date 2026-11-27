const apiPath = "/b2api/v4/";
const apiOrigin = "https://api.backblazeb2.com";
const albumPrefix = "doi-album/";
const authorizationLifetime = 60 * 60 * 1000;
let cachedAuthorization;

class B2Error extends Error {
  constructor(status, code) {
    super("Backblaze B2 request failed");
    this.status = status;
    this.code = code;
  }
}

function backblazeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/(^|\.)(backblazeb2|backblaze)\.com$/.test(url.hostname)) {
    throw new Error("Unexpected Backblaze address");
  }
  return url;
}

function b2Fetch(url, options) {
  return fetch(backblazeUrl(url), { cache: "no-store", redirect: "manual", ...options });
}

async function b2Json(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new B2Error(response.status, data?.code);
  return data;
}

async function authorization(env) {
  const { B2_KEY_ID: id, B2_APPLICATION_KEY: key, B2_BUCKET: name } = env;
  if (cachedAuthorization?.id === id && cachedAuthorization.key === key &&
      cachedAuthorization.name === name && cachedAuthorization.expires > Date.now()) {
    return cachedAuthorization.result;
  }
  const response = await b2Fetch(apiOrigin + apiPath + "b2_authorize_account", {
    headers: { Authorization: "Basic " + btoa(id + ":" + key) },
  });
  const auth = await b2Json(response);
  const { allowed, apiUrl, downloadUrl } = auth.apiInfo.storageApi;
  const bucket = allowed.buckets?.find((item) => item.name === name);
  if (!bucket) throw new Error("The B2 key must be restricted to the DoI bucket");
  const result = { apiUrl, downloadUrl, token: auth.authorizationToken, bucketId: bucket.id };
  cachedAuthorization = { id, key, name, result, expires: Date.now() + authorizationLifetime };
  return result;
}

function fileInfo(metadata) {
  return { doi_author: metadata.authorId, doi_name: decodeURIComponent(metadata.name) };
}

function storageObject({ fileName, fileId, contentLength, contentType, uploadTimestamp, fileInfo: info }) {
  return {
    key: fileName.slice(albumPrefix.length),
    size: contentLength,
    uploaded: new Date(uploadTimestamp),
    httpEtag: '"' + fileId + '"',
    customMetadata: { authorId: info.doi_author, name: encodeURIComponent(info.doi_name), type: contentType },
  };
}

function uploadHeaders(size, checksum) {
  return { "Content-Length": String(size), "X-Bz-Content-Sha1": checksum };
}

export function b2Album(env) {
  if (!env.B2_KEY_ID || !env.B2_APPLICATION_KEY || !env.B2_BUCKET) return null;

  async function call(action, fields) {
    const { apiUrl, token, bucketId } = await authorization(env);
    const response = await b2Fetch(apiUrl + apiPath + action, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify({ ...fields, ...(fields.bucketId ? { bucketId } : {}) }),
    });
    return b2Json(response);
  }

  async function send(target, body, headers) {
    const response = await b2Fetch(target.uploadUrl, {
      method: "POST", body, headers: { ...headers, Authorization: target.authorizationToken },
    });
    return b2Json(response);
  }

  async function download(key, range, method) {
    const { downloadUrl, token } = await authorization(env);
    const path = [env.B2_BUCKET, ...(albumPrefix + key).split("/")].map(encodeURIComponent).join("/");
    const headers = { Authorization: token };
    if (range) headers.Range = "bytes=" + range.offset + "-" + (range.offset + range.length - 1);
    const response = await b2Fetch(downloadUrl + "/file/" + path, { method, headers });
    if (response.status === 404) return null;
    if (!response.ok) throw new B2Error(response.status);
    const authorId = response.headers.get("X-Bz-Info-doi_author");
    const name = response.headers.get("X-Bz-Info-doi_name");
    const type = response.headers.get("Content-Type");
    const size = Number(response.headers.get("Content-Length"));
    const fileId = response.headers.get("X-Bz-File-Id");
    const uploaded = new Date(Number(response.headers.get("X-Bz-Upload-Timestamp")));
    if (!authorId || name === null || !type || !fileId || !size || (range && size !== range.length)) {
      await response.body?.cancel();
      throw new Error("Unexpected Backblaze file response");
    }
    return {
      key, size, uploaded,
      httpEtag: '"' + fileId + '"',
      customMetadata: { authorId, name, type },
      body: response.body,
    };
  }

  return {
    requiresChecksum: true,
    needsExpiredAbort: true,
    head: (key) => download(key, null, "HEAD"),
    get: (key, { range } = {}) => download(key, range, "GET"),
    async list({ prefix, cursor, limit }) {
      const path = albumPrefix + prefix;
      if (cursor && !cursor.startsWith(path)) throw new Error("Invalid Backblaze list cursor");
      const data = await call("b2_list_file_names", {
        bucketId: true, prefix: path, startFileName: cursor ?? undefined, maxFileCount: limit,
      });
      const files = data.files.filter(({ fileInfo: info }) => typeof info?.doi_name === "string" && info.doi_author);
      return { objects: files.map(storageObject), truncated: Boolean(data.nextFileName), cursor: data.nextFileName };
    },
    async put(key, body, { customMetadata, size, checksum }) {
      const info = fileInfo(customMetadata);
      const fileName = albumPrefix + key;
      const target = await call("b2_get_upload_url", { bucketId: true });
      const file = await send(target, body, {
        ...uploadHeaders(size, checksum),
        "Content-Type": customMetadata.type,
        "X-Bz-File-Name": encodeURIComponent(fileName),
        "X-Bz-Info-doi_author": encodeURIComponent(info.doi_author),
        "X-Bz-Info-doi_name": encodeURIComponent(info.doi_name),
      });
      return storageObject(file);
    },
    async delete(key) {
      const fileName = albumPrefix + key;
      let cursor;
      do {
        const result = await call("b2_list_file_versions", {
          bucketId: true, prefix: fileName, maxFileCount: 24,
        });
        // Delete older versions first so a failed request never restores one to the album.
        const matches = result.files.filter((file) => file.fileName === fileName);
        cursor = result.nextFileName;
        const deletions = cursor === fileName ? matches.slice(1) : matches;
        for (const { fileId } of deletions.reverse()) {
          await call("b2_delete_file_version", { fileName, fileId }).catch((error) => {
            if (error.code !== "file_not_present") throw error;
          });
        }
      } while (cursor === fileName);
    },
    async createMultipartUpload(key, { customMetadata }) {
      const { fileId } = await call("b2_start_large_file", {
        bucketId: true, fileName: albumPrefix + key, contentType: customMetadata.type,
        fileInfo: fileInfo(customMetadata),
      });
      return this.resumeMultipartUpload(key, fileId);
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        uploadId,
        async uploadPart(partNumber, body, { size, checksum }) {
          const target = await call("b2_get_upload_part_url", { fileId: uploadId });
          const data = await send(target, body, {
            ...uploadHeaders(size, checksum), "X-Bz-Part-Number": String(partNumber),
          });
          return { partNumber: data.partNumber, etag: data.contentSha1 };
        },
        async complete(parts) {
          const file = await call("b2_finish_large_file", {
            fileId: uploadId, partSha1Array: parts.map(({ etag }) => etag),
          });
          const object = storageObject(file);
          if (object.key !== key) throw new Error("Unexpected Backblaze file name");
          return object;
        },
        async abort() {
          await call("b2_cancel_large_file", { fileId: uploadId }).catch((error) => {
            if (error.code !== "file_not_present" && error.code !== "not_present") throw error;
          });
        },
      };
    },
  };
}
