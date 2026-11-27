import { formatDay, localDay } from "./dates.js";
import {
  fileMediaType, mediaAccept, mediaLimitsLabel, mediaMaxBytes, singleUploadMaxBytes, uploadPartBytes,
} from "./media.js";

function albumUrl(spaceId, id, fields = {}) {
  return "./api/album" + (id ? "/" + id : "") + "?" + new URLSearchParams({ space: spaceId, ...fields });
}

async function albumResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = new Error(data?.message ?? "共享相册暂时不可用，请稍后重试。");
    failure.code = data?.code;
    throw failure;
  }
  if (!data) throw new Error("共享相册暂时不可用，请稍后重试。");
  return data;
}

async function albumRequest(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options }).catch(() => {
    if (options?.signal?.aborted) throw new DOMException("上传已暂停。", "AbortError");
    throw new Error("请联网后重试。");
  });
  return albumResponse(response);
}

async function sendUpload(url, file, headers, updateProgress, signal) {
  const hash = await crypto.subtle.digest("SHA-1", await file.arrayBuffer());
  const checksum = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Promise((resolve, reject) => {
    if (signal.aborted) throw new DOMException("上传已暂停。", "AbortError");
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.timeout = 10 * 60 * 1000;
    request.responseType = "json";
    for (const [header, value] of Object.entries(headers)) request.setRequestHeader(header, value);
    request.setRequestHeader("X-DoI-Sha1", checksum);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) updateProgress(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300 && request.response) {
        resolve(request.response);
      } else {
        const failure = new Error(request.response?.message ?? "上传失败，请重试。");
        failure.code = request.response?.code;
        reject(failure);
      }
    };
    request.onerror = () => reject(new Error("连接中断，请联网后重试。"));
    request.ontimeout = () => reject(new Error("上传超时，请重试。"));
    const abort = () => request.abort();
    request.onabort = () => reject(new DOMException("上传已暂停。", "AbortError"));
    request.onloadend = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    request.send(file);
  });
}

function uploadAction(spaceId, id, action, body, signal) {
  return albumRequest(albumUrl(spaceId, id, { action }), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

async function uploadLargeVideo(spaceId, draft, file, type, name, updateProgress, pause, signal) {
  const { id, parts } = draft;
  if (!draft.ready) {
    const start = await uploadAction(spaceId, id, "start", { name, type, size: file.size }, signal);
    if (start.item) return;
    draft.ready = true;
  }

  pause.hidden = false;
  for (let offset = parts.length * uploadPartBytes; offset < file.size; offset += uploadPartBytes) {
    const number = parts.length + 1;
    const chunk = file.slice(offset, offset + uploadPartBytes);
    const result = await sendUpload(albumUrl(spaceId, id, { action: "part", part: number }),
      chunk, { "Content-Type": "application/octet-stream" },
      (fraction) => updateProgress((offset + fraction * chunk.size) / file.size), signal);
    if (result.part?.partNumber !== number || !result.part.etag) throw new Error("未能确认这个分片，请重试。");
    parts.push(result.part);
    updateProgress((offset + chunk.size) / file.size);
  }
  pause.hidden = true;
  await uploadAction(spaceId, id, "finish", { parts }, signal);
}

export function albumView(profile, ui) {
  const { element, button, heading, emptyState, openCouple, sheetLayout, sheet, setSheetBusy, notify } = ui;
  if (!profile.space?.paired) {
    return [
      heading("相册"),
      emptyState("与伴侣完成配对后，即可上传并一起查看图片和视频。"),
      button("前往情侣空间", openCouple, "button primary"),
    ];
  }

  const spaceId = profile.space.id;
  const list = element("ul", "album-grid");
  list.addEventListener("contextmenu", (event) => event.preventDefault());
  const status = element("p", "empty-state", "正在加载相册…");
  status.setAttribute("role", "status");
  let cursor = null;
  let loading = false;
  let refreshPending = false;
  let loaded = false;
  const more = button("查看更多", () => void load(true), "button secondary");
  more.hidden = true;
  const refresh = button("刷新", () => void load(), "small-button");

  async function load(append = false) {
    if (loading) {
      if (!append) refreshPending = true;
      return;
    }
    loading = true;
    more.disabled = refresh.disabled = true;
    try {
      const data = await albumRequest(albumUrl(spaceId, null, append ? { cursor } : {}));
      cursor = data.cursor;
      const tiles = data.items.map(tile);
      if (append) list.append(...tiles);
      else list.replaceChildren(...tiles);
      loaded = true;
      status.textContent = list.children.length ? "" : "相册还是空的，添加一张照片或一段视频吧。";
      status.hidden = Boolean(list.children.length);
    } catch (error) {
      status.textContent = error.message;
      status.hidden = false;
    } finally {
      loading = false;
      add.disabled = !loaded;
      more.disabled = refresh.disabled = false;
      more.hidden = !cursor;
      if (refreshPending) {
        refreshPending = false;
        void load();
      }
    }
  }

  function tile(item) {
    const video = item.type.startsWith("video/");
    const preview = element("span", "album-tile-preview",
      element("span", video ? "album-play" : "nav-icon nav-album", video ? "▶" : null));
    preview.setAttribute("aria-hidden", "true");
    if (!video) {
      const image = element("img");
      image.alt = "";
      image.loading = "lazy";
      image.draggable = false;
      image.addEventListener("error", () => image.remove());
      image.src = albumUrl(spaceId, item.id);
      preview.append(image);
    }
    const owner = item.authorId === profile.accountId ? "你上传的" : "伴侣上传的";
    const date = formatDay(localDay(new Date(item.createdAt)), true);
    const uploadedOn = element("time", "", date);
    uploadedOn.dateTime = item.createdAt;
    const control = button("", () => previewItem(item, owner, date), "album-tile card");
    control.setAttribute("aria-label", (video ? "视频" : "照片") + " " + date + " " + owner);
    control.append(preview, element("span", "album-tile-caption",
      element("strong", "", uploadedOn), element("small", "", owner)));
    return element("li", "", control);
  }

  function previewItem(item, owner, date) {
    if (sheet.open) return;
    const isVideo = item.type.startsWith("video/");
    const media = element(isVideo ? "video" : "img", "album-preview");
    if (isVideo) {
      media.controls = true;
      media.setAttribute("controlsList", "nodownload");
      media.playsInline = true;
      media.preload = "metadata";
      media.setAttribute("aria-label", "视频");
    } else {
      media.alt = "照片";
      media.draggable = false;
    }
    media.addEventListener("contextmenu", (event) => event.preventDefault());
    const error = element("p", "inline-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    media.addEventListener("error", () => {
      if (!media.hasAttribute("src")) return;
      error.textContent = "无法预览。请确认网络连接，或在支持此文件格式的设备上打开。";
      error.hidden = false;
    });
    media.src = albumUrl(spaceId, item.id);
    const actions = [element("p", "range", owner + " · " + date)];
    if (item.authorId === profile.accountId) {
      const remove = button("删除文件", async () => {
        if (!window.confirm("从两人的共享相册中删除这个文件？")) return;
        remove.disabled = true;
        setSheetBusy(true);
        try {
          await albumRequest(albumUrl(spaceId, item.id), { method: "DELETE" });
          sheet.close();
          notify("文件已删除。");
          void load();
        } catch (failure) {
          error.textContent = failure.message;
          error.hidden = false;
        } finally {
          setSheetBusy(false);
          remove.disabled = false;
        }
      }, "button danger");
      actions.push(remove);
    }
    sheet.addEventListener("close", () => {
      if (isVideo) media.pause();
      media.removeAttribute("src");
      if (isVideo) media.load();
    }, { once: true });
    sheetLayout(isVideo ? "视频" : "照片", [media, error], actions, element("div", "sheet-layout album-viewer"));
    // Start playback in the tap handler so Safari treats it as a user action.
    if (isVideo) void media.play().catch(() => {});
  }

  function openUpload() {
    if (sheet.open) return;
    const form = element("form", "sheet-layout");
    const input = element("input", "input album-file");
    input.type = "file";
    input.accept = mediaAccept;
    input.required = true;
    const submit = element("button", "button primary", "上传");
    submit.type = "submit";
    const feedback = element("p", "inline-error");
    feedback.setAttribute("role", "alert");
    feedback.hidden = true;
    const progress = element("progress", "album-progress");
    progress.setAttribute("aria-label", "上传进度");
    progress.max = 1;
    progress.hidden = true;
    let draft;
    let controller;
    const pause = button("暂停上传", () => controller?.abort(), "button secondary");
    pause.hidden = true;

    function discardUpload() {
      if (draft?.ready) void uploadAction(spaceId, draft.id, "cancel", {}).catch(() => {});
      draft = null;
    }

    input.addEventListener("change", () => {
      discardUpload();
      feedback.hidden = true;
      progress.hidden = true;
      submit.textContent = "上传";
    });
    sheet.addEventListener("close", () => {
      controller?.abort();
      discardUpload();
    }, { once: true });

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submit.disabled || !input.files.length) return;
      const file = input.files[0];
      const type = fileMediaType(file);
      const message = !type ? "请选择受支持的图片或视频。"
        : !file.size ? "选择的文件是空的。" : file.size > mediaMaxBytes(type) ? mediaLimitsLabel : "";
      feedback.hidden = !message;
      if (message) {
        feedback.textContent = message;
        return;
      }
      const trimmedName = file.name.trim().slice(0, 180).replace(/[\uD800-\uDFFF]/gu, "\ufffd");
      const name = trimmedName || (type.startsWith("image/") ? "图片" : "视频");
      const large = file.size > singleUploadMaxBytes;
      draft ??= {
        id: String(9_999_999_999_999 - Date.now()) + "-" + crypto.randomUUID() + (large ? "-m" : ""),
        parts: [], ready: false,
      };
      const activeDraft = draft;
      controller = new AbortController();
      const { signal } = controller;
      setSheetBusy(true);
      input.disabled = submit.disabled = true;
      submit.textContent = "正在上传…";
      progress.value = Math.min(1, draft.parts.length * uploadPartBytes / file.size);
      progress.hidden = false;
      try {
        const updateProgress = (value) => { progress.value = value; };
        if (large) {
          await uploadLargeVideo(spaceId, activeDraft, file, type, name, updateProgress, pause, signal);
        } else {
          const url = albumUrl(spaceId, activeDraft.id, { size: file.size });
          await sendUpload(url, file, {
            "Content-Type": type, "X-DoI-Filename": encodeURIComponent(name),
          }, updateProgress, signal);
        }
        draft = null;
        sheet.close();
        notify("已上传，伴侣现在可以查看。");
        void load();
      } catch (failure) {
        if (failure?.code === "uploadExpired") discardUpload();
        feedback.textContent = signal.aborted ? "已暂停，继续上传会从上次成功的分片接着传。" : failure.message;
        feedback.hidden = false;
      } finally {
        controller = null;
        setSheetBusy(false);
        input.disabled = submit.disabled = false;
        pause.hidden = true;
        submit.textContent = draft?.ready ? "继续上传" : "上传";
        progress.hidden = !draft?.ready;
        if (draft) progress.value = Math.min(1, draft.parts.length * uploadPartBytes / file.size);
      }
    });
    sheetLayout("添加图片或视频", [
      element("p", "range", "上传后，情侣空间的两位成员都能查看。" + mediaLimitsLabel),
      element("label", "field", element("span", "field-label", "选择文件"), input),
      progress,
    ], [feedback, pause, submit], form);
  }

  const add = button("+ 添加", openUpload, "button primary");
  add.disabled = true;
  void load();
  return [
    heading("相册", element("div", "album-actions", refresh, add)),
    status, list, more,
  ];
}
