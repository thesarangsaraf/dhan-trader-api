export function decodeJwtPayload(token: string): any {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length < 2) return null;

  try {
    let payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payloadBase64.length % 4) {
      payloadBase64 += '=';
    }
    const jsonStr = Buffer.from(payloadBase64, 'base64').toString('utf8');
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

export function formatIST(date: Date): string {
  if (!date || isNaN(date.getTime())) return 'N/A';
  return (
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(date) + ' IST'
  );
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) {
    const absSec = Math.abs(totalSeconds);
    const h = Math.floor(absSec / 3600);
    const m = Math.floor((absSec % 3600) / 60);
    return `Expired ${h > 0 ? `${h}h ` : ''}${m}m ago`;
  }
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  return `${mins}m ${secs}s`;
}
