import { dayKey, dayNumber, timeSlots, weekday, weekdays } from "./dates.js";

const durationBuckets = [
  { label: "＜15", upper: 14 },
  { label: "15–24", upper: 24 },
  { label: "25–34", upper: 34 },
  { label: "35–44", upper: 44 },
  { label: "45–54", upper: 54 },
  { label: "55+", upper: Infinity },
];

function countDays(records, { start, end }) {
  const counts = new Map();
  for (const { occurredOn } of records) {
    if (occurredOn >= start && occurredOn <= end) {
      counts.set(occurredOn, (counts.get(occurredOn) ?? 0) + 1);
    }
  }
  return counts;
}

export function calculateStats(records, range) {
  const relevant = records.filter(({ occurredOn }) => occurredOn >= range.start && occurredOn <= range.end);
  const dates = [...countDays(relevant, range).keys()].map(dayNumber).sort((a, b) => a - b);
  const duration = durationBuckets.map(({ label }) => ({ label, count: 0 }));
  const byWeekday = weekdays.map((label) => ({ label: "周" + label, count: 0 }));
  const byTimeSlot = timeSlots.map(({ label }) => ({ label, count: 0 }));
  const slotPositions = new Map(timeSlots.map(({ id }, index) => [id, index]));

  let previousDate = -Infinity;
  let streak = 0;
  let longestStreak = 0;
  for (const date of dates) {
    streak = date === previousDate + 1 ? streak + 1 : 1;
    longestStreak = Math.max(longestStreak, streak);
    previousDate = date;
  }

  let samples = 0;
  let mean = 0;
  let unspecified = 0;
  for (const record of relevant) {
    byWeekday[weekday(dayNumber(record.occurredOn))].count += 1;
    if (record.timeSlot === null) unspecified += 1;
    else byTimeSlot[slotPositions.get(record.timeSlot)].count += 1;
    if (record.durationMinutes !== null) {
      const index = durationBuckets.findIndex(({ upper }) => record.durationMinutes <= upper);
      duration[index].count += 1;
      samples += 1;
      mean += (record.durationMinutes - mean) / samples;
    }
  }

  const daysInRange = dayNumber(range.end) - dayNumber(range.start) + 1;
  return {
    total: relevant.length,
    activeDays: dates.length,
    weeklyAverage: daysInRange > 0 ? relevant.length * 7 / daysInRange : 0,
    longestStreak,
    duration: { samples, mean: samples ? mean : null, buckets: duration },
    byWeekday,
    byTimeSlot,
    unspecified,
    timeSamples: relevant.length - unspecified,
  };
}

export function buildHeatmap(records, range) {
  const counts = countDays(records, range);
  const first = dayNumber(range.start);
  const last = dayNumber(range.end);
  return {
    offset: weekday(first),
    days: Array.from({ length: last - first + 1 }, (_, index) => {
      const date = dayKey(first + index);
      return { date, count: counts.get(date) ?? 0 };
    }),
  };
}
