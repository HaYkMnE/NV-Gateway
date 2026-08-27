import { getGatewayApi } from './api';

export async function startGatewayProcess(port?: number): Promise<boolean> {
  const api = getGatewayApi();
  const res = await api.startGateway(port);
  return res.success;
}

export async function stopGatewayProcess(): Promise<boolean> {
  const api = getGatewayApi();
  const res = await api.stopGateway();
  return res.success;
}

export async function restartGatewayProcess(port?: number): Promise<boolean> {
  const api = getGatewayApi();
  const res = await api.restartGateway(port);
  return res.success;
}
