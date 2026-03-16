import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../../..");

describe("Nginx Configuration", () => {
  const templatePath = join(ROOT_DIR, "front/nginx.conf.template");
  const dockerfilePath = join(ROOT_DIR, "front/Dockerfile");

  let templateContent;
  let dockerfileContent;

  beforeAll(() => {
    // Read files if they exist
    if (existsSync(templatePath)) {
      templateContent = readFileSync(templatePath, "utf-8");
    }
    if (existsSync(dockerfilePath)) {
      dockerfileContent = readFileSync(dockerfilePath, "utf-8");
    }
  });

  describe("nginx.conf.template", () => {
    it("should exist", () => {
      expect(existsSync(templatePath)).toBe(true);
    });

    it("should use envsubst syntax for API_URL variable", () => {
      expect(templateContent).toContain("${API_URL}");
      // Should NOT use bash-style default syntax which nginx doesn't support
      expect(templateContent).not.toMatch(/\$\{API_URL-[^}]+\}/);
    });

    it("should have fallback for when API_URL is empty", () => {
      expect(templateContent).toMatch(/if\s*\(\s*\$backend_url\s*=\s*""\s*\)/);
      expect(templateContent).toContain('set $backend_url "http://api:4242"');
    });

    it("should proxy /api/v1/ requests", () => {
      expect(templateContent).toContain("location /api/v1/");
      expect(templateContent).toContain("proxy_pass $backend_url");
    });

    it("should have DNS resolver for Docker service discovery", () => {
      expect(templateContent).toContain("resolver 127.0.0.11");
    });

    it("should have connection timeouts configured", () => {
      expect(templateContent).toContain("proxy_connect_timeout");
      expect(templateContent).toContain("proxy_send_timeout");
      expect(templateContent).toContain("proxy_read_timeout");
    });

    it("should have error handling for backend failures", () => {
      expect(templateContent).toContain("proxy_intercept_errors on");
      expect(templateContent).toContain("error_page 502 503 504");
    });

    it("should return JSON error response", () => {
      expect(templateContent).toContain("location @api_unavailable");
      expect(templateContent).toContain("application/json");
      expect(templateContent).toContain("Service temporarily unavailable");
    });

    it("should serve static files from correct directory", () => {
      expect(templateContent).toContain("root /usr/share/nginx/html");
    });

    it("should have SPA routing for React", () => {
      expect(templateContent).toContain("location /");
      expect(templateContent).toContain("try_files $uri /index.html");
    });

    it("should not have syntax errors - balanced braces", () => {
      const openBraces = (templateContent.match(/{/g) || []).length;
      const closeBraces = (templateContent.match(/}/g) || []).length;
      expect(openBraces).toBe(closeBraces);
    });

    it("should not have syntax errors - balanced quotes", () => {
      // Count unescaped double quotes (should be even)
      const quotes = (templateContent.match(/(?<!\\)"/g) || []).length;
      expect(quotes % 2).toBe(0);
    });

    it("should have server block", () => {
      expect(templateContent).toMatch(/server\s*{/);
    });

    it("should listen on port 80", () => {
      expect(templateContent).toMatch(/listen\s+80;/);
    });
  });

  describe("Dockerfile", () => {
    it("should exist", () => {
      expect(existsSync(dockerfilePath)).toBe(true);
    });

    it("should copy nginx.conf.template to templates directory", () => {
      expect(dockerfileContent).toContain("nginx.conf.template");
      expect(dockerfileContent).toContain("/etc/nginx/templates/");
    });

    it("should use nginx official image", () => {
      expect(dockerfileContent).toMatch(/FROM nginx:/);
    });

    it("should not copy nginx.conf directly to conf.d", () => {
      // Should NOT have: COPY nginx.conf /etc/nginx/conf.d/
      expect(dockerfileContent).not.toMatch(/COPY\s+nginx\.conf\s+\/etc\/nginx\/conf\.d/);
    });
  });

  describe("Environment variable configuration", () => {
    it("should document API_URL in .env.example", () => {
      const envExamplePath = join(ROOT_DIR, ".env.example");
      expect(existsSync(envExamplePath)).toBe(true);
      const envExampleContent = readFileSync(envExamplePath, "utf-8");
      expect(envExampleContent).toContain("API_URL");
    });
  });
});
