export const STOREFRONT_ATTRIBUTION_HTML = 'Data from <a href="https://data.cityofnewyork.us/d/92iy-9c3n" target="_blank" rel="noopener noreferrer">NYC Department of Finance · Storefronts Reported Vacant or Not (92iy-9c3n)</a>.';
export const NTA_ATTRIBUTION_HTML = '<a href="https://data.cityofnewyork.us/d/9nt8-h7nd" target="_blank" rel="noopener noreferrer">NYC DCP · 2020 NTA boundaries</a>.';
export function storefrontSourceAge(updatedAt: string, now = Date.now()): string {
  const instant = Date.parse(updatedAt);
  if (!Number.isFinite(instant)) return 'Source update unavailable';
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(instant);
  const days = Math.max(0, Math.floor((now - instant) / 86_400_000));
  return `Source updated ${date} · ${days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} old`}`;
}
