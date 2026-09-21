import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function isPrivateIpv4(value: string): boolean {
  const parts = value.split(".").map(Number);
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIpv6(value: string): boolean {
  const normalized = value.toLocaleLowerCase("en");
  const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("fc") || normalized.startsWith("fd") || (mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false);
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  return version === 4 ? isPrivateIpv4(address) : version === 6 ? isPrivateIpv6(address) : true;
}

export async function validateRemoteUrl(value: string, allowPrivateNetwork: boolean): Promise<URL> {
  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed");
  if (url.username || url.password) throw new Error("Credentials must not be embedded in URLs");
  if (["localhost", "localhost.localdomain"].includes(url.hostname.toLocaleLowerCase("en")) && !allowPrivateNetwork) throw new Error("Private network destinations are not permitted");
  if (!allowPrivateNetwork) {
    const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Private network destinations are not permitted");
  }
  return url;
}
