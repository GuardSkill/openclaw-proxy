// @ts-nocheck
import { ProxyAgent } from "undici";
import { wrapFetchWithAbortSignal } from "./fetch.js";

let originalFetch: typeof fetch | undefined;
let proxyInstalled = false;
let installedProxyUrl: string | undefined;

/**
 * Resolve proxy URL from config or environment variables.
 * Config takes precedence over environment variables.
 */
export function resolveProxyUrl(configProxy?: string): string | undefined {
  const trimmed = configProxy?.trim();
  if (trimmed) return trimmed;
  return (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    undefined
  );
}

/**
 * Install a proxy-aware fetch as the global fetch.
 * All HTTP requests will go through the specified proxy.
 *
 * @param proxyUrl - The proxy URL (e.g., "http://127.0.0.1:7890")
 */
export function installProxyFetch(proxyUrl: string): void {
  if (proxyInstalled) {
    if (installedProxyUrl === proxyUrl) return;
    uninstallProxyFetch();
  }

  originalFetch = globalThis.fetch;
  const agent = new ProxyAgent(proxyUrl);

  const proxyFetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const base = init ? { ...init } : {};
    return originalFetch!(input, { ...base, dispatcher: agent } as RequestInit);
  };

  globalThis.fetch = wrapFetchWithAbortSignal(proxyFetch);
  proxyInstalled = true;
  installedProxyUrl = proxyUrl;
}

/**
 * Restore the original global fetch (remove proxy).
 */
export function uninstallProxyFetch(): void {
  if (!proxyInstalled || !originalFetch) return;
  globalThis.fetch = originalFetch;
  originalFetch = undefined;
  proxyInstalled = false;
  installedProxyUrl = undefined;
}

/**
 * Check if proxy fetch is currently installed.
 */
export function isProxyFetchInstalled(): boolean {
  return proxyInstalled;
}

/**
 * Get the currently installed proxy URL, if any.
 */
export function getInstalledProxyUrl(): string | undefined {
  return installedProxyUrl;
}
