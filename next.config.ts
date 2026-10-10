import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Hostnames allowed to request dev-only assets.
   *
   * The dev server otherwise permits only `localhost` and whatever hostname it
   * was started with, and blocks everything else. That block is invisible in
   * the page itself: the HTML and the JS bundles are served normally, so the
   * page renders and looks fine, but the dev-only endpoints the React client
   * needs are refused, hydration never completes, and nothing is clickable.
   *
   * The spec is mobile-first and reviewers test on a phone, which means
   * reaching the dev server from another device on the network -- so these
   * ranges are listed deliberately. Each `*` stands for exactly one hostname
   * label, which for an IP address is one octet.
   *
   * - 172.20.10.*  an iPhone Personal Hotspot
   * - 172.28.*.*   eduroam, and other campus networks on 172.16/12
   * - 192.168.*.*  a typical home or office LAN
   * - 10.*.*.*     the other common private range
   * - tunnels      a trusted certificate for iOS, which is strict about
   *                self-signed ones
   *
   * Development only; `next build` ignores this entirely.
   */
  allowedDevOrigins: [
    "172.20.10.*",
    "172.28.*.*",
    "192.168.*.*",
    "10.*.*.*",
    "**.trycloudflare.com",
    "**.ngrok-free.app",
    "**.ngrok.io",
  ],
};

export default nextConfig;
