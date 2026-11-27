import { dayNumber, timeSlots } from "./dates.js";

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ids = new Set(timeSlots.map(({ id }) => id));

export function isTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

export function normalizeRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("记录格式不正确。");
  }
  const { id, occurredOn, timeSlot, durationMinutes, note, createdAt, updatedAt } = value;
  if (typeof id !== "string" || !uuidPattern.test(id)) throw new Error("记录 ID 无效。");
  if (!Number.isFinite(dayNumber(occurredOn))) throw new Error("请选择有效的日期。");
  if (timeSlot !== null && !ids.has(timeSlot)) throw new Error("时段无效。");
  if (durationMinutes !== null && (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1)) {
    throw new Error("时长请输入正整数分钟。");
  }
  if (typeof note !== "string") throw new Error("备注格式不正确。");
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt) || updatedAt < createdAt) {
    throw new Error("记录时间戳无效。");
  }
  return { id, occurredOn, timeSlot, durationMinutes, note: note.trim() ? note : "", createdAt, updatedAt };
}
