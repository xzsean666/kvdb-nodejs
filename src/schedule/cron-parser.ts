// Lightweight zero-dependency 5-field Cron parser and matcher
import { KvdbConfigError } from "../core/errors.js";

const PREDEFINED_CRON_ALIASES: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  const parts = field.split(",");

  for (const part of parts) {
    if (part === "*") {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (part.startsWith("*/")) {
      const step = Number.parseInt(part.slice(2), 10);
      if (Number.isNaN(step) || step <= 0) {
        throw new KvdbConfigError(`Invalid cron step: "${part}"`);
      }
      for (let i = min; i <= max; i += step) result.add(i);
    } else if (part.includes("-")) {
      const slashIdx = part.indexOf("/");
      const rangePart = slashIdx >= 0 ? part.slice(0, slashIdx) : part;
      const stepPart = slashIdx >= 0 ? part.slice(slashIdx + 1) : undefined;
      const dashIdx = rangePart.indexOf("-");
      const startStr = rangePart.slice(0, dashIdx);
      const endStr = rangePart.slice(dashIdx + 1);

      const start = Number.parseInt(startStr, 10);
      const end = Number.parseInt(endStr, 10);
      const step = stepPart ? Number.parseInt(stepPart, 10) : 1;

      if (Number.isNaN(start) || Number.isNaN(end) || Number.isNaN(step) || step <= 0 || start > end) {
        throw new KvdbConfigError(`Invalid cron range: "${part}"`);
      }
      for (let i = Math.max(min, start); i <= Math.min(max, end); i += step) {
        result.add(i);
      }
    } else {
      const num = Number.parseInt(part, 10);
      if (Number.isNaN(num) || num < min || num > max) {
        throw new KvdbConfigError(`Invalid cron value: "${part}" (must be ${min}-${max})`);
      }
      result.add(num);
    }
  }

  return result;
}

export function parseCronExpression(expression: string): ParsedCron {
  const trimmed = expression.trim();
  const resolved = PREDEFINED_CRON_ALIASES[trimmed] ?? trimmed;
  const fields = resolved.split(/\s+/);

  if (fields.length !== 5 || !fields[0] || !fields[1] || !fields[2] || !fields[3] || !fields[4]) {
    throw new KvdbConfigError(
      `Cron expression must have exactly 5 fields (minute hour dayOfMonth month dayOfWeek), got: "${expression}"`,
    );
  }

  // Minute: 0-59
  const minutes = parseField(fields[0], 0, 59);
  // Hour: 0-23
  const hours = parseField(fields[1], 0, 23);
  // Day of Month: 1-31
  const daysOfMonth = parseField(fields[2], 1, 31);
  // Month: 1-12
  const months = parseField(fields[3], 1, 12);
  // Day of Week: 0-7 (0 and 7 are Sunday)
  const rawDaysOfWeek = parseField(fields[4], 0, 7);
  const daysOfWeek = new Set<number>();
  for (const d of rawDaysOfWeek) {
    daysOfWeek.add(d === 7 ? 0 : d);
  }

  return { minutes, hours, daysOfMonth, months, daysOfWeek };
}

/**
 * Compute the next matching timestamp (strictly greater than fromTimestamp)
 * for a given cron expression.
 */
export function getNextCronTime(expression: string, fromTimestamp: number = Date.now()): number {
  const parsed = parseCronExpression(expression);

  // Advance by 1 full minute, zeroing seconds and milliseconds
  const date = new Date(fromTimestamp);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);

  // Maximum search horizon: 5 years into the future
  const maxIterations = 5 * 366 * 24 * 60;
  let iterations = 0;

  while (iterations++ < maxIterations) {
    const month = date.getMonth() + 1; // 1-12
    if (!parsed.months.has(month)) {
      // Advance to start of next month
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }

    const dayOfMonth = date.getDate(); // 1-31
    const dayOfWeek = date.getDay(); // 0-6
    if (!parsed.daysOfMonth.has(dayOfMonth) || !parsed.daysOfWeek.has(dayOfWeek)) {
      // Advance to start of next day
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = date.getHours(); // 0-23
    if (!parsed.hours.has(hour)) {
      // Advance to start of next hour
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }

    const minute = date.getMinutes(); // 0-59
    if (!parsed.minutes.has(minute)) {
      date.setMinutes(date.getMinutes() + 1);
      continue;
    }

    return date.getTime();
  }

  throw new KvdbConfigError(`Could not find a matching execution time for cron "${expression}" within 5 years`);
}
