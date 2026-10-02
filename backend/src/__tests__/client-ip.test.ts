import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createClientIpResolver, getClientIp } from "../lib/client-ip";

const TRUST_PROXY = "loopback,linklocal,uniquelocal";

async function resolve(
  resolver: typeof getClientIp,
  remoteAddress: string,
  headers: Record<string, string>
): Promise<string> {
  const app = fastify({ trustProxy: TRUST_PROXY });
  app.get("/", async (request) => ({ ip: resolver(request) }));
  try {
    const res = await app.inject({ method: "GET", url: "/", remoteAddress, headers });
    return res.json().ip;
  } finally {
    await app.close();
  }
}

describe("getClientIp", () => {
  it("a) uses CF-Connecting-IP when the proxied peer is a Cloudflare edge", async () => {
    const ip = await resolve(getClientIp, "10.0.1.12", {
      "x-forwarded-for": "104.22.191.13",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(ip).toBe("203.0.113.7");
  });

  it("b) falls back to request.ip when CF-Connecting-IP is absent", async () => {
    const ip = await resolve(getClientIp, "10.0.1.12", { "x-forwarded-for": "104.22.191.13" });
    expect(ip).toBe("104.22.191.13");
  });

  it("c) falls back to request.ip when CF-Connecting-IP is not an IP address", async () => {
    const ip = await resolve(getClientIp, "10.0.1.12", {
      "x-forwarded-for": "104.22.191.13",
      "cf-connecting-ip": "not-an-ip",
    });
    expect(ip).toBe("104.22.191.13");
  });

  it("d) ignores CF-Connecting-IP when the proxied peer is not Cloudflare", async () => {
    const ip = await resolve(getClientIp, "10.0.1.12", {
      "x-forwarded-for": "198.51.100.9",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(ip).toBe("198.51.100.9");
  });

  it("e) ignores CF-Connecting-IP and a forged X-Forwarded-For on a direct public connection", async () => {
    const ip = await resolve(getClientIp, "198.51.100.9", {
      "x-forwarded-for": "104.22.191.13",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(ip).toBe("198.51.100.9");
  });

  it("f) supports IPv6 Cloudflare edges and IPv6 visitors", async () => {
    const ip = await resolve(getClientIp, "10.0.1.12", {
      "x-forwarded-for": "2606:4700::1111",
      "cf-connecting-ip": "2001:db8::1",
    });
    expect(ip).toBe("2001:db8::/64");
  });

  it("treats an IPv4-mapped IPv6 Cloudflare peer as IPv4", async () => {
    const resolver = createClientIpResolver();
    const ip = await resolve(resolver, "::ffff:104.22.191.13", {
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(ip).toBe("203.0.113.7");
  });

  it("ignores CF-Connecting-IP from a non-Cloudflare IPv6 peer", async () => {
    const ip = await resolve(getClientIp, "2001:db8::5", { "cf-connecting-ip": "203.0.113.7" });
    expect(ip).toBe("2001:db8::/64");
  });
});

describe("getClientIp rate-limit keys (IPv6 collapses to /64)", () => {
  const viaCloudflare = (visitor: string) =>
    resolve(getClientIp, "10.0.1.12", {
      "x-forwarded-for": "104.22.191.13",
      "cf-connecting-ip": visitor,
    });

  it("gives two CF-Connecting-IP values in the same /64 the same key", async () => {
    expect(await viaCloudflare("2001:db8:1:2::a")).toBe("2001:db8:1:2::/64");
    expect(await viaCloudflare("2001:db8:1:2:ffff::b")).toBe("2001:db8:1:2::/64");
  });

  it("gives values in different /64s different keys", async () => {
    const a = await viaCloudflare("2001:db8:1:2::a");
    const b = await viaCloudflare("2001:db8:1:3::a");
    expect(a).toBe("2001:db8:1:2::/64");
    expect(b).toBe("2001:db8:1:3::/64");
    expect(a).not.toBe(b);
  });

  it("collapses uppercase and leading-zero IPv6 to the same key as the lowercase form", async () => {
    expect(await viaCloudflare("2001:0DB8:0001:0002::1")).toBe("2001:db8:1:2::/64");
    expect(await viaCloudflare("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
  });

  it("formats full, short and zero-run addresses canonically", async () => {
    expect(await viaCloudflare("2001:db8:abcd:1234:aaaa:bbbb:cccc:dddd")).toBe(
      "2001:db8:abcd:1234::/64"
    );
    expect(await viaCloudflare("2001:DB8::1")).toBe("2001:db8::/64");
    expect(await viaCloudflare("fe80::1")).toBe("fe80::/64");
    expect(await viaCloudflare("::1")).toBe("::/64");
    expect(await viaCloudflare("2001:db8:0:0:5::1")).toBe("2001:db8::/64");
    expect(await viaCloudflare("2001:db8:0:5::1")).toBe("2001:db8:0:5::/64");
  });

  it("returns the dotted IPv4 for an IPv4-mapped CF-Connecting-IP", async () => {
    expect(await viaCloudflare("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(await viaCloudflare("::ffff:cb00:7107")).toBe("203.0.113.7");
  });

  it("collapses a direct (non-Cloudflare) IPv6 peer to its /64", async () => {
    expect(await resolve(getClientIp, "2001:db8:9:9::5", {})).toBe("2001:db8:9:9::/64");
  });

  it("collapses IPv6 when the Cloudflare path is disabled", async () => {
    const resolver = createClientIpResolver("none");
    expect(await resolve(resolver, "2001:db8:9:9::5", {})).toBe("2001:db8:9:9::/64");
  });

  it("leaves IPv4 keys unchanged", async () => {
    expect(await viaCloudflare("203.0.113.7")).toBe("203.0.113.7");
    expect(await resolve(getClientIp, "198.51.100.9", {})).toBe("198.51.100.9");
  });
});

describe("createClientIpResolver CLOUDFLARE_IP_RANGES", () => {
  const cfRequest = {
    "x-forwarded-for": "104.22.191.13",
    "cf-connecting-ip": "203.0.113.7",
  };

  it("g) 'none' disables the Cloudflare path", async () => {
    const resolver = createClientIpResolver("none");
    expect(await resolve(resolver, "10.0.1.12", cfRequest)).toBe("104.22.191.13");
  });

  it("blank value uses the built-in ranges", async () => {
    const resolver = createClientIpResolver("   ");
    expect(await resolve(resolver, "10.0.1.12", cfRequest)).toBe("203.0.113.7");
  });

  it("a custom list replaces the built-in ranges", async () => {
    const resolver = createClientIpResolver("198.51.100.0/24, 2001:db8:ffff::/48");
    // 104.22.191.13 is built-in Cloudflare but not in the override list.
    expect(await resolve(resolver, "10.0.1.12", cfRequest)).toBe("104.22.191.13");
    expect(
      await resolve(resolver, "10.0.1.12", {
        "x-forwarded-for": "198.51.100.9",
        "cf-connecting-ip": "203.0.113.7",
      })
    ).toBe("203.0.113.7");
  });

  it("h) throws on an invalid entry", () => {
    expect(() => createClientIpResolver("198.51.100.0/24,bogus")).toThrow(
      /Invalid CLOUDFLARE_IP_RANGES entry "bogus"/
    );
    expect(() => createClientIpResolver("198.51.100.0/33")).toThrow(
      /Invalid CLOUDFLARE_IP_RANGES entry/
    );
    expect(() => createClientIpResolver("198.51.100.0")).toThrow(
      /Invalid CLOUDFLARE_IP_RANGES entry/
    );
    expect(() => createClientIpResolver("2001:db8::/129")).toThrow(
      /Invalid CLOUDFLARE_IP_RANGES entry/
    );
  });
});
