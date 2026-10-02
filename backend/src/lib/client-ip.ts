import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

// Cloudflare edge ranges, copied verbatim from the published lists:
//   https://www.cloudflare.com/ips-v4
//   https://www.cloudflare.com/ips-v6
// Retrieved 2026-10-02. Re-fetch periodically; override at runtime with the
// CLOUDFLARE_IP_RANGES env var (comma-separated CIDRs, or "none" to disable).
const CLOUDFLARE_IP_RANGES = [
  // IPv4
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  // IPv6
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

const IPV4_MAPPED_PREFIX = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function normalizeAddress(address: string): { address: string; family: "ipv4" | "ipv6" } | null {
  const mapped = IPV4_MAPPED_PREFIX.exec(address);
  const candidate = mapped ? (mapped[1] as string) : address;
  const version = isIP(candidate);
  if (version === 0) return null;
  return { address: candidate, family: version === 4 ? "ipv4" : "ipv6" };
}

/** Expands a valid IPv6 literal to its 8 numeric 16-bit groups (zone id and dotted-quad tail handled). */
function expandIpv6(address: string): number[] {
  let text = address;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = tail.split(".").map(Number) as [number, number, number, number];
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const [headText = "", tailText] = text.split("::");
  const head = headText === "" ? [] : headText.split(":");
  const rest = tailText === undefined || tailText === "" ? [] : tailText.split(":");
  const fill = tailText === undefined ? 0 : 8 - head.length - rest.length;
  return [...head, ...Array<string>(fill).fill("0"), ...rest].map((group) =>
    Number.parseInt(group, 16)
  );
}

/**
 * Collapses an IP address to its rate-limit key:
 *  - IPv4, and IPv4-mapped IPv6 (::ffff:203.0.113.7), -> the dotted IPv4 ("203.0.113.7").
 *  - IPv6 -> its /64 prefix: the first four hextets in lowercase hex without leading
 *    zeros, trailing all-zero hextets elided, then "::/64"
 *    ("2001:DB8:0:1:aaaa::5" -> "2001:db8:0:1::/64", "2001:db8::1" -> "2001:db8::/64").
 * An IPv6 visitor normally controls a whole /64, so keying on the full address would let
 * it dodge per-IP limits by rotating addresses. Non-IP input is returned unchanged.
 */
function toRateLimitKey(address: string): string {
  if (isIP(address) !== 6) return address; // IPv4 (already a plain key) or not an IP

  const mapped = IPV4_MAPPED_PREFIX.exec(address);
  if (mapped) return mapped[1] as string;

  const groups = expandIpv6(address);
  // Hex-form IPv4-mapped address (::ffff:cb00:7107).
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const [hi, lo] = [groups[6] as number, groups[7] as number];
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }

  const prefix = groups.slice(0, 4);
  while (prefix.length > 0 && prefix[prefix.length - 1] === 0) prefix.pop();
  return `${prefix.map((g) => g.toString(16)).join(":")}::/64`;
}

function buildBlockList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [prefix, bitsText, ...rest] = cidr.split("/");
    const version = prefix ? isIP(prefix) : 0;
    const bits = bitsText !== undefined && /^\d+$/.test(bitsText) ? Number(bitsText) : Number.NaN;
    const maxBits = version === 4 ? 32 : 128;
    if (rest.length > 0 || version === 0 || !(bits >= 0 && bits <= maxBits)) {
      throw new Error(
        `Invalid CLOUDFLARE_IP_RANGES entry "${cidr}": expected a CIDR such as 203.0.113.0/24 or 2001:db8::/32`
      );
    }
    list.addSubnet(prefix as string, bits, version === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

/**
 * Builds a client-IP resolver. The resolver returns a rate-limit key, not a raw
 * address: IPv6 clients collapse to their /64 prefix (see toRateLimitKey).
 * `rangesEnv` is the raw CLOUDFLARE_IP_RANGES value:
 * unset/blank uses the built-in Cloudflare ranges, a comma-separated CIDR list
 * replaces them (invalid entries throw), and "none" disables the Cloudflare path.
 */
export function createClientIpResolver(rangesEnv?: string): (request: FastifyRequest) => string {
  const trimmed = rangesEnv?.trim() ?? "";
  const disabled = trimmed.toLowerCase() === "none";
  const cidrs =
    trimmed === ""
      ? CLOUDFLARE_IP_RANGES
      : trimmed
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "");
  const cloudflare = disabled ? null : buildBlockList(cidrs);

  return function resolveClientIp(request: FastifyRequest): string {
    // request.ip is already proxy-aware (Fastify trustProxy).
    const peerIp = request.ip;
    if (!peerIp) return "unknown";
    if (!cloudflare) return toRateLimitKey(peerIp);

    // CF-Connecting-IP is honoured only when the connection demonstrably came
    // from Cloudflare (which overwrites the header), so a client that reaches
    // the origin any other way cannot choose its own rate-limit key.
    const peer = normalizeAddress(peerIp);
    if (!peer || !cloudflare.check(peer.address, peer.family)) return toRateLimitKey(peerIp);

    const header = request.headers["cf-connecting-ip"];
    const raw = Array.isArray(header) ? header[0] : header;
    const value = raw?.trim();
    if (value && isIP(value) !== 0) return toRateLimitKey(value);

    return toRateLimitKey(peerIp);
  };
}

/** Rate-limit key for the request's client: the IPv4 address, or the /64 prefix for IPv6. */
export const getClientIp = createClientIpResolver(process.env.CLOUDFLARE_IP_RANGES);
