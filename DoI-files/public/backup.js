import { localDay } from "./dates.js";
import { getRecords } from "./db.js";
import { isTimestamp, normalizeRecord } from "./record.js";

const backupFormat = "doi-backup";
const backupVersion = 1;

export async function prepareBackup(shared = null) {
  const records = shared ? shared.map(normalizeRecord) : await getRecords();
  const contents = JSON.stringify({
    format: backupFormat,
    version: backupVersion,
    exportedAt: new Date().toISOString(),
    records,
  }, null, 2) + "\n";
  return new File([contents], "DoI-backup-" + localDay() + ".json", { type: "application/json" });
}

export async function parseBackup(file) {
  let value;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new Error("无法读取 JSON 备份。请选择 DoI 导出的文件。");
  }
  if (
    value?.format !== backupFormat ||
    value.version !== backupVersion ||
    !isTimestamp(value.exportedAt) ||
    !Array.isArray(value.records)
  ) {
    throw new Error("此文件的备份格式或版本不受支持。");
  }
  return value.records.map((record, index) => {
    try {
      return normalizeRecord(record);
    } catch (error) {
      throw new Error("第 " + (index + 1) + " 条记录无法恢复。" + error.message);
    }
  });
}

export function supportsFileShare(file) {
  return typeof navigator.share === "function" && typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });
}

export function downloadBackup(file) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
