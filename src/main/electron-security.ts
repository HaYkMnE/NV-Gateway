export const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

export function secureWebContents(contents: { setWindowOpenHandler(handler: () => { action: "deny" }): void; on(event: string, listener: (event: { preventDefault(): void }, url: string) => void): void }, exactUrl: string): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => { if (url !== exactUrl) event.preventDefault(); });
}

export function installSecurityHeaders(targetSession: { webRequest: { onHeadersReceived(listener: (details: any, callback: (response: any) => void) => void): void } }): void {
  targetSession.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [PRODUCTION_CSP] } }));
}

export function installElectronSecurity(options: {
  targetSession: { webRequest: { onHeadersReceived(listener: (details: any, callback: (response: any) => void) => void): void }; setPermissionRequestHandler(handler: (contents: unknown, permission: string, callback: (allowed: boolean) => void) => void): void };
  contents: Parameters<typeof secureWebContents>[0];
  exactUrl: string;
}): void {
  installSecurityHeaders(options.targetSession);
  options.targetSession.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permission === "clipboard-read" || permission === "clipboard-sanitize-write"));
  secureWebContents(options.contents, options.exactUrl);
}
