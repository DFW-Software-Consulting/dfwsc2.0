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
 * Builds a client-IP resolver. `rangesEnv` is the raw CLOUDFLARE_IP_RANGES value:
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
    if (!cloudflare) return peerIp;

    // CF-Connecting-IP is honoured only when the connection demonstrably came
    // from Cloudflare (which overwrites the header), so a client that reaches
    // the origin any other way cannot choose its own rate-limit key.
    const peer = normalizeAddress(peerIp);
    if (!peer || !cloudflare.check(peer.address, peer.family)) return peerIp;

    const header = request.headers["cf-connecting-ip"];
    const raw = Array.isArray(header) ? header[0] : header;
    const value = raw?.trim();
    if (value && isIP(value) !== 0) return value;

    return peerIp;
  };
}

export const getClientIp = createClientIpResolver(process.env.CLOUDFLARE_IP_RANGES);
