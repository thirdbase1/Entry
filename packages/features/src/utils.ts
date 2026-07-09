/**
 * Replaces core/quota/utils.ts. Ported verbatim.
 */
const OneKB = 1024;
const OneDay = 1000 * 60 * 60 * 24;

export const ByteUnit = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

export function formatSize(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 B';
  const dm = decimals < 0 ? 0 : decimals;
  const i = Math.floor(Math.log(bytes) / Math.log(OneKB));
  return parseFloat((bytes / Math.pow(OneKB, i)).toFixed(dm)) + ' ' + ByteUnit[i];
}

export function formatDate(ms: number): string {
  return `${(ms / OneDay).toFixed(0)} days`;
}
