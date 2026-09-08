import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CustomDomainGuide, customDomainProxyExample, type CustomDomainStatus } from "./CustomDomainSettings";

const status: CustomDomainStatus = {
  publicUrl: "https://old.example.com",
  customDomain: null,
  fallbackUrl: "https://old.example.com",
  supported: true,
  appPort: 23456,
  webhookPort: 23457,
};

describe("custom domain setup guidance", () => {
  it("uses this server's ports and leaves both app and hooks on loopback", () => {
    const config = customDomainProxyExample(status);
    expect(config).toContain("reverse_proxy 127.0.0.1:23456");
    expect(config).toContain("reverse_proxy 127.0.0.1:23457");
    expect(config).toContain("handle /hooks/*");
    expect(config).toContain("flush_interval -1");
    expect(config).not.toContain("0.0.0.0");
  });

  it("explains DNS and HTTPS are configured separately before verification", () => {
    const html = renderToStaticMarkup(createElement(CustomDomainGuide, { status }));
    expect(html).toContain("A record");
    expect(html).toContain("AAAA");
    expect(html).toContain("administrator must configure HTTPS");
    expect(html).toContain("exact workspace before saving");
    expect(html).toContain("Never publish the app");
    expect(html).toContain("bots.example.com");
    expect(html).not.toContain(status.publicUrl!);
  });
});
