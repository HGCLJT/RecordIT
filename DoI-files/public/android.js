const maxBackupBytes = 10 * 1024 * 1024;
let documentPending = false;

export function hasAndroidDocuments() {
  return typeof globalThis.DoiAndroid?.postMessage === "function";
}

async function documentRequest(action, fields = {}) {
  if (!hasAndroidDocuments()) throw new Error("安卓文件功能不可用。");
  if (documentPending) throw new Error("请先关闭已打开的文件选择器。");

  const bridge = globalThis.DoiAndroid;
  const id = crypto.randomUUID();
  documentPending = true;
  try {
    const response = await new Promise((resolve, reject) => {
      bridge.onmessage = ({ data }) => {
        try {
          const result = JSON.parse(data);
          if (result.id === id) resolve(result);
        } catch {
          reject(new Error("无法读取安卓文件处理结果。"));
        }
      };
      bridge.postMessage(JSON.stringify({ id, action, ...fields }));
    });
    if (response.status === "cancelled" || response.status === "ok") return response;
    if (response.status === "tooLarge") throw new Error("备份文件超过安卓端的 10 MB 上限。");
    throw new Error("文件操作失败，请选择可访问的位置后重试。");
  } finally {
    bridge.onmessage = null;
    documentPending = false;
  }
}

export async function saveAndroidBackup(file) {
  if (file.size > maxBackupBytes) throw new Error("备份文件超过安卓端的 10 MB 上限。");
  const result = await documentRequest("save", { name: file.name, contents: await file.text() });
  return result.status === "ok";
}

export async function chooseAndroidBackup() {
  const result = await documentRequest("open");
  if (result.status === "cancelled") return null;
  return new Blob([result.contents], { type: "application/json" });
}
