import fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TRUSTED_PROXIES, resolveTrustProxy } from "../app";

describe("resolveTrustProxy", () => {
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env.TRUST_PROXY;
  });

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = originalValue;
    }
  });

  it("defaults to the private-network list when unset", () => {
    delete process.env.TRUST_PROXY;
    expect(resolveTrustProxy()).toBe(DEFAULT_TRUSTED_PROXIES);
    expect(DEFAULT_TRUSTED_PROXIES).toBe("loopback,linklocal,uniquelocal");
  });

  it("defaults to the private-network list when blank", () => {
    process.env.TRUST_PROXY = "   ";
    expect(resolveTrustProxy()).toBe(DEFAULT_TRUSTED_PROXIES);
  });

  it('maps "true" to true', () => {
    process.env.TRUST_PROXY = "true";
    expect(resolveTrustProxy()).toBe(true);
  });

  it('maps "false" to false', () => {
    process.env.TRUST_PROXY = "false";
    expect(resolveTrustProxy()).toBe(false);
  });

  it.each(["1", "2"])("maps legacy hop count %s to the default list", (hops) => {
    process.env.TRUST_PROXY = hops;
    expect(resolveTrustProxy()).toBe(DEFAULT_TRUSTED_PROXIES);
  });

  it("passes a trimmed IP/CIDR list through as-is", () => {
    process.env.TRUST_PROXY = " 10.0.0.0/8, 192.168.1.5 ";
    expect(resolveTrustProxy()).toBe("10.0.0.0/8, 192.168.1.5");
  });
});

describe("trustProxy behaviour with the default list", () => {
  let originalValue: string | undefined;
  let app: ReturnType<typeof fastify>;

  beforeEach(async () => {
    originalValue = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
    app = fastify({ trustProxy: resolveTrustProxy() });
    app.get("/ip", async (request) => ({ ip: request.ip }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (originalValue === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = originalValue;
    }
  });

  async function ipFor(remoteAddress: string, forwardedFor: string): Promise<string> {
    const res = await app.inject({
      method: "GET",
      url: "/ip",
      remoteAddress,
      headers: { "x-forwarded-for": forwardedFor },
    });
    return res.json().ip;
  }

  it("uses X-Forwarded-For when the peer is a private-network proxy", async () => {
    expect(await ipFor("172.18.0.5", "203.0.113.7")).toBe("203.0.113.7");
  });

  it("ignores X-Forwarded-For when the peer is a public address", async () => {
    expect(await ipFor("198.51.100.9", "203.0.113.7")).toBe("198.51.100.9");
  });

  it("uses the right-most untrusted address, not a client-supplied left-most entry", async () => {
    expect(await ipFor("172.18.0.5", "1.2.3.4, 203.0.113.7")).toBe("203.0.113.7");
  });
});
