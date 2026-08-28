import { createContext, useContext } from 'react';

export interface GatewayLifecycleSnapshot {
  status?: GatewayStatus;
  isError: boolean;
  refetch: () => Promise<unknown>;
}

const unavailableSnapshot: GatewayLifecycleSnapshot = {
  status: undefined,
  isError: false,
  refetch: async () => undefined
};

export const GatewayLifecycleContext = createContext<GatewayLifecycleSnapshot>(unavailableSnapshot);

export function useGatewayLifecycle(): GatewayLifecycleSnapshot {
  return useContext(GatewayLifecycleContext);
}
