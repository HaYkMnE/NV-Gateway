import { requestAdmin as requestAdminClient, type AdminRequest } from "./admin-client";
import { type GatewayStatus } from "./gateway-lifecycle";

export interface AdminIpcUnavailableResult {
  ok: false;
  error: {
    code: "GATEWAY_NOT_RUNNING";
    message: "Gateway is not running.";
  };
}

export type AdminIpcResult<T> = T | AdminIpcUnavailableResult;

export interface AdminIpcDispatcherOptions {
  getStatus: () => GatewayStatus;
  isStopping?: () => boolean;
  getCredentials: () => { port: number; token: string };
  requestAdmin?: typeof requestAdminClient;
}

const GATEWAY_NOT_RUNNING: AdminIpcUnavailableResult = {
  ok: false,
  error: {
    code: "GATEWAY_NOT_RUNNING",
    message: "Gateway is not running."
  }
};

export function createAdminIpcDispatcher(options: AdminIpcDispatcherOptions): (request: AdminRequest) => Promise<AdminIpcResult<unknown>> {
  const sendAdminRequest = options.requestAdmin ?? requestAdminClient;
  const gatewayUnavailable = (): boolean => options.getStatus().state !== "running" || options.isStopping?.() === true;
  return async (request) => {
    if (gatewayUnavailable()) return GATEWAY_NOT_RUNNING;
    const { port, token } = options.getCredentials();
    if (gatewayUnavailable()) return GATEWAY_NOT_RUNNING;
    return sendAdminRequest(port, token, request);
  };
}
