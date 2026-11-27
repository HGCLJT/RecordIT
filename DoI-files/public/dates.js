const dayMilliseconds = 86_400_000;

export const timeSlots = [
  { id: "early_morning", label: "凌晨", startHour: 0 },
  { id: "morning", label: "上午", startHour: 6 },
  { id: "noon", label: "中午", startHour: 11 },
  { id: "afternoon", label: "下午", startHour: 14 },
  { id: "evening", label: "晚上", startHour: 18 },
];

export const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

export function localDay(now = new Date()) {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

export function currentTimeSlot(now = new Date()) {
  return timeSlots.findLast(({ startHour }) => startHour <= now.getHours()).id;
}

export function timeSlotLabel(value) {
  return timeSlots.find(({ id }) => id === value)?.label ?? "";
}

export function dayNumber(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return NaN;
  return date.getTime() / dayMilliseconds;
}

export function dayKey(ordinal) {
  return new Date(ordinal * dayMilliseconds).toISOString().slice(0, 10);
}

export function weekday(ordinal) {
  return new Date(ordinal * dayMilliseconds).getUTCDay();
}

export function shiftMonth(month, offset) {
  const [year, number] = month.split("-").map(Number);
  const monthIndex = year * 12 + number - 1 + offset;
  const nextYear = Math.floor(monthIndex / 12);
  if (nextYear < 1 || nextYear > 9999) return month;
  return String(nextYear).padStart(4, "0") + "-" + String(monthIndex % 12 + 1).padStart(2, "0");
}

export function monthBounds(month) {
  const start = month + "-01";
  const next = shiftMonth(month, 1);
  const end = next === month ? month + "-31" : dayKey(dayNumber(next + "-01") - 1);
  return { start, end };
}

export function statsRange(month, today) {
  if (month === "recent") {
    return { start: dayKey(Math.max(dayNumber("0001-01-01"), dayNumber(today) - 364)), end: today };
  }
  const { start, end } = monthBounds(month);
  return { start, end: end > today ? today : end };
}

export function formatDay(value, withYear = false) {
  const [year, month, day] = value.split("-").map(Number);
  const label = month + " 月 " + day + " 日";
  return withYear ? year + " 年 " + label : label;
}

export function formatMonth(value) {
  const [year, month] = value.split("-").map(Number);
  return year + " 年 " + month + " 月";
}
