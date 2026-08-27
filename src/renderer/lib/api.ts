import type { GatewayApi } from '../../preload';

export function getGatewayApi(): GatewayApi {
  if (typeof window === 'undefined' || !window.gatewayApi) {
    throw new Error('gatewayApi is not available in the current environment.');
  }

  return window.gatewayApi;
}

export function isGatewayApiAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.gatewayApi);
}

export function openExternalUrl(url: string): Promise<boolean> {
  const api = getGatewayApi();
  return api.openExternal(url);
}
