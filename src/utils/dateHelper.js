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