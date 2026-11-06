import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../../..");

describe("Frontend Dockerfile", () => {
  const dockerfilePath = join(ROOT_DIR, "front/Dockerfile");
  let dockerfileContent;

  beforeAll(() => {
    if (existsSync(dockerfilePath)) {
      dockerfileContent = readFileSync(dockerfilePath, "utf-8");
    }
  });

  describe("Dockerfile configuration", () => {
    it("should exist", () => {
      expect(existsSync(dockerfilePath)).toBe(true);
    });

    it("should use multi-stage build", () => {
      expect(dockerfileContent).toMatch(/FROM.*AS builder/);
      expect(dockerfileContent).toMatch(/FROM.*AS production/);
    });

    it("should use node:22-alpine base image", () => {
      expect(dockerfileContent).toMatch(/FROM node:22-alpine/);
    });

    it("should build with Vite", () => {
      expect(dockerfileContent).toContain("npm run build");
    });

    it("should set VITE_API_URL build argument", () => {
      expect(dockerfileContent).toContain("ARG VITE_API_URL");
      expect(dockerfileContent).toContain("ENV VITE_API_URL");
    });

    it("should set analytics build arguments and derive a restrictive CSP origin", () => {
      expect(dockerfileContent).toContain("ARG VITE_ANALYTICS_SRC");
      expect(dockerfileContent).toContain("ARG VITE_ANALYTICS_DOMAIN");
      expect(dockerfileContent).toContain("ENV VITE_ANALYTICS_SRC");
      expect(dockerfileContent).toContain("ENV VITE_ANALYTICS_DOMAIN");
      expect(dockerfileContent).toContain("nginx.production.conf");
    });

    it("should restrict analytics CSP to the build-derived origin", () => {
      const nginxConfig = readFileSync(join(ROOT_DIR, "front/nginx.conf"), "utf-8");

      expect(nginxConfig).toContain("script-src 'self' __ANALYTICS_ORIGIN__");
      expect(nginxConfig).toContain(
        "connect-src 'self' https://api.dfwsc.com __ANALYTICS_ORIGIN__"
      );
      expect(nginxConfig).not.toContain("script-src 'self' https:;");
      expect(nginxConfig).not.toContain("connect-src 'self' https:;");
    });

    it("should never let an /assets/ or 404 response be cached after a failed fetch", () => {
      const nginxConfig = readFileSync(join(ROOT_DIR, "front/nginx.conf"), "utf-8");
      const rules = nginxConfig
        .slice(nginxConfig.indexOf('map "$status:$uri" $static_cache_control'))
        .split("}")[0];
      const at = (needle) => {
        const i = rules.indexOf(needle);
        expect(i, needle).toBeGreaterThan(-1);
        return i;
      };

      // Immutable only for statuses that actually served the file; everything else is no-store.
      expect(rules).toContain('"~^(200|206|304):/assets/" "public, max-age=31536000, immutable"');
      expect(rules).toContain('"~^\\d+:/assets/" "no-store"');
      expect(rules).toContain('"~^404:" "no-store"');
      expect(nginxConfig).toContain("try_files $uri @asset_missing;");

      // First match wins: /api/ opts out, and 404 must beat the .html no-cache rule or
      // "404:/404.html" would be cacheable-with-revalidation instead of no-store.
      expect(at('"~^\\d+:/api/" ""')).toBeLessThan(at('"~^404:"'));
      expect(at('"~^(200|206|304):/assets/"')).toBeLessThan(at('"~^\\d+:/assets/"'));
      expect(at('"~^404:"')).toBeLessThan(at('"~\\.html$"'));
    });

    it("should not set add_header inside a location (it would drop the security headers)", () => {
      const nginxConfig = readFileSync(join(ROOT_DIR, "front/nginx.conf"), "utf-8");
      const server = nginxConfig.slice(nginxConfig.indexOf("server {"));
      const locations = server.split(/^ {4}location /m).slice(1);
      expect(locations.length).toBeGreaterThan(0);
      for (const block of locations) {
        expect(block.split(/^ {4}\}/m)[0]).not.toMatch(/\badd_header\b/);
      }
    });

    it("should copy build output to nginx html directory", () => {
      expect(dockerfileContent).toContain("COPY --from=builder");
      expect(dockerfileContent).toContain("/usr/share/nginx/html");
    });

    it("should use nginx:alpine for production (Coolify-compatible)", () => {
      expect(dockerfileContent).toMatch(/FROM nginx:alpine AS production/);
      expect(dockerfileContent).toMatch(/CMD.*nginx/);
    });

    it("should expose port 80", () => {
      expect(dockerfileContent).toContain("EXPOSE 80");
    });

    it("should use nginx to serve static files", () => {
      expect(dockerfileContent).toContain("nginx");
      expect(dockerfileContent).toContain("daemon off");
    });
  });

  describe("Environment variable configuration", () => {
    it("should have a .env.example file", () => {
      const envExamplePath = join(ROOT_DIR, ".env.example");
      expect(existsSync(envExamplePath)).toBe(true);
    });
  });
});
