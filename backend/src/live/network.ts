import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blocked4 = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked4.addSubnet(address, prefix);
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
const blocked6 = new BlockList();
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked6.addSubnet(address, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked4.check(address) : family === 6 && global6.check(address, 'ipv6') && !blocked6.check(address, 'ipv6');
}
export function publicHttpsUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash || url.search) throw new Error('Use a public HTTPS URL on port 443 without credentials, query parameters, or a fragment.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.test') || (isIP(hostname) && !isPublicAddress(hostname))) throw new Error('Private and local addresses cannot be tested by the public runner.');
  return url;
}
export interface PublicResponse { httpStatus: number; body: string; responseBytes: number; finalUrl: string; contentType: string }
export type PublicFetcher = (url: string) => Promise<PublicResponse>;
export async function fetchPublicPage(input: string): Promise<PublicResponse> {
  const original = publicHttpsUrl(input); let url = original;
  const deadline = Date.now() + 12000;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Website DNS lookup timed out.')), Math.max(1, deadline - Date.now())); }),
    ]).finally(() => clearTimeout(timer));
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Website DNS resolved to a private or reserved network address.');
    const pinned = addresses.find(item => item.family === 4) ?? addresses[0]!;
    const response = await new Promise<PublicResponse & { location?: string }>((resolve, reject) => {
      const req = request(url, { method: 'GET', family: pinned.family,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: { Accept: 'text/html,application/json,text/plain;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'BizPlusAI-Monitor/1.0' },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 512 * 1024) { req.destroy(new Error('Website response exceeds the 512 KB inspection limit.')); return; }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ httpStatus: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), responseBytes: size, finalUrl: url.href, contentType: String(res.headers['content-type'] ?? ''), location: res.headers.location }));
      });
      const remaining = Math.max(1, deadline - Date.now());
      const timeout = setTimeout(() => req.destroy(new Error('Website request timed out after 12 seconds.')), remaining);
      req.on('close', () => clearTimeout(timeout)); req.on('error', reject); req.end();
    });
    if (![301,302,303,307,308].includes(response.httpStatus) || !response.location) return response;
    if (redirects === 3) throw new Error('Website exceeded the three-redirect limit.');
    const next = publicHttpsUrl(new URL(response.location, url).href);
    if (next.origin !== original.origin) throw new Error('Website redirected to a different origin; configure its final owned URL instead.');
    url = next;
  }
  throw new Error('Website could not be inspected.');
}
