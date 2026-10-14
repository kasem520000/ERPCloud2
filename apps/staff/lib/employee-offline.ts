export type OfflinePunch = {
  clientId: string;
  type: 'check_in' | 'check_out';
  lat: number;
  lng: number;
  at: string;
};

const KEY = 'erp-employee-punches';

export function readPunchQueue(): OfflinePunch[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '[]') as OfflinePunch[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function enqueuePunch(punch: OfflinePunch): OfflinePunch[] {
  const queue = readPunchQueue();
  if (queue.some((row) => row.clientId === punch.clientId)) return queue;
  const next = [...queue, punch];
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearSyncedPunches(clientIds: string[]): OfflinePunch[] {
  const done = new Set(clientIds);
  const next = readPunchQueue().filter((row) => !done.has(row.clientId));
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}
