export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function configuration(env = process.env) {
  if (env.NODE_ENV === 'production' && !env.OBSERVER_TOKEN) throw new Error('Production observer requires a server-only OBSERVER_TOKEN.');
  const url = new URL(env.BIZPLUS_ORIGIN || 'https://bizplus-ai-api.onrender.com');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (!loopback && (url.protocol !== 'https:' || (url.port && url.port !== '443'))) ||
    (loopback && (env.OBSERVER_ALLOW_LOCAL !== 'true' || !['http:', 'https:'].includes(url.protocol)))) {
    throw new Error('BIZPLUS_ORIGIN must be a fixed HTTPS origin; loopback test origins require OBSERVER_ALLOW_LOCAL=true.');
  }
  const intervalMs = Number(env.OBSERVER_INTERVAL_MS || 30000);
  const journeyIntervalMs = Number(env.OBSERVER_JOURNEY_INTERVAL_MS || 300000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000 ||
      !Number.isInteger(journeyIntervalMs) || journeyIntervalMs < 1000 || journeyIntervalMs > 86400000) {
    throw new Error('Observer intervals are invalid.');
  }
  return {
    origin: url.origin,
    port: Number(env.PORT || 3002),
    intervalMs,
    journeyIntervalMs,
    token: env.OBSERVER_TOKEN || '',
    databasePath: env.OBSERVER_DATABASE_PATH || './data/observer.sqlite',
    historyPolicy: env.OBSERVER_HISTORY_POLICY === 'local' ? 'local' : 'temporary',
  };
}
