import { DateTime } from 'luxon';

const TIMEZONE = 'America/New_York';

export function parseEstDate(dateString) {
  if (!dateString) return null;
  
  const dt = DateTime.fromISO(dateString, { zone: TIMEZONE });
  return dt.toJSDate();
}

export function parseEstTimestamp(dateString) {
  if (!dateString) return null;
  
  const dt = DateTime.fromISO(dateString, { zone: TIMEZONE });
  return dt.isValid ? dt.toMillis() : null;
}

export function nowEst() {
  return DateTime.now().setZone(TIMEZONE);
}

export function formatForSync(dateTime) {
  return dateTime.toFormat("yyyy-MM-dd'T'HH:mm:ss");
}

export function getSyncDate(intervalMs, startDate = null) {
  let dateTime;
  if (startDate) {
    if (typeof startDate === 'string') {
      dateTime = DateTime.fromISO(startDate, { zone: TIMEZONE });
      if (!dateTime.isValid) {
        dateTime = DateTime.fromJSDate(new Date(startDate), { zone: TIMEZONE });
      }
    } else {
      dateTime = DateTime.fromJSDate(startDate, { zone: TIMEZONE });
    }
  } else {
    dateTime = nowEst();
  }
  
  const syncDate = dateTime.minus({ milliseconds: intervalMs });
  return formatForSync(syncDate);
}

/**
 * Convert an ISO date string (or JS Date / epoch-ms number) to Unix seconds.
 * Falls back to (now − fallbackMs) when the input is invalid or missing.
 *
 * @param {string|Date|number|null} value   ISO string, Date, or epoch-ms
 * @param {number}                  [fallbackMs=300000]  Fallback window (default 5 min)
 * @returns {number} Unix epoch seconds
 */
export function toUnixSeconds(value, fallbackMs = 5 * 60 * 1000) {
  if (value == null) {
    return Math.floor((Date.now() - fallbackMs) / 1000);
  }

  if (typeof value === 'number') {
    // Already epoch-ms or epoch-seconds — normalise
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }

  let dt;
  if (value instanceof Date) {
    dt = DateTime.fromJSDate(value, { zone: TIMEZONE });
  } else {
    dt = DateTime.fromISO(String(value), { zone: TIMEZONE });
    if (!dt.isValid) {
      dt = DateTime.fromJSDate(new Date(value), { zone: TIMEZONE });
    }
  }

  if (!dt.isValid) {
    return Math.floor((Date.now() - fallbackMs) / 1000);
  }

  return Math.floor(dt.toMillis() / 1000);
}