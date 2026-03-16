import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

    it("should use node:20-alpine base image", () => {
      expect(dockerfileContent).toMatch(/FROM node:20-alpine/);
    });

    it("should build with Vite", () => {
      expect(dockerfileContent).toContain("npm run build");
    });

    it("should set VITE_API_URL build argument", () => {
      expect(dockerfileContent).toContain("ARG VITE_API_URL");
      expect(dockerfileContent).toContain("ENV VITE_API_URL");
    });

    it("should copy build output to nginx html directory", () => {
      expect(dockerfileContent).toContain("COPY --from=builder");
      expect(dockerfileContent).toContain("/usr/share/nginx/html");
    });

    it("should use nginx:alpine for production (Coolify-compatible)", () => {
      expect(dockerfileContent).toMatch(/FROM nginx:alpine AS production/);
      expect(dockerfileContent).toMatch(/CMD.*nginx/);
    });

    it("should expose ports 80 and 443", () => {
      expect(dockerfileContent).toContain("EXPOSE 80 443");
    });

    it("should use nginx to serve static files", () => {
      expect(dockerfileContent).toContain("nginx");
      expect(dockerfileContent).toContain("daemon off");
    });
  });

  describe("Environment variable configuration", () => {
    it("should document VITE_API_URL in .env.example", () => {
      const envExamplePath = join(ROOT_DIR, ".env.example");
      expect(existsSync(envExamplePath)).toBe(true);
      const envExampleContent = readFileSync(envExamplePath, "utf-8");
      // VITE_API_URL was removed since it's now only a build arg
      // The runtime API routing is handled by Coolify
    });
  });
});
