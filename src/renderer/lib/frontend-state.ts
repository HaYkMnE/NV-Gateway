import { useState, useEffect, useTransition } from 'react';
import type { GatewayState, KeyItem, AppSettings, LogEntry } from '../../preload';
import { getGatewayApi, isGatewayApiAvailable } from './api';

export interface UseGatewayDataResult {
  state: GatewayState | null;
  keys: KeyItem[];
  settings: AppSettings | null;
  logs: LogEntry[];
  isLoading: boolean;
  error: Error | null;
  isPending: boolean;
  refresh: () => void;
}

export function useGatewayData(): UseGatewayDataResult {
  const [state, setState] = useState<GatewayState | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [isPending, startTransition] = useTransition();

  const loadData = () => {
    if (!isGatewayApiAvailable()) {
      setIsLoading(false);
      return;
    }

    const api = getGatewayApi();
    startTransition(async () => {
      try {
        const [nextState, nextKeys, nextSettings, nextLogs] = await Promise.all([
          api.getState(),
          api.getKeys(),
          api.getSettings(),
          api.getLogs(),
        ]);

        setState(nextState);
        setKeys(nextKeys);
        setSettings(nextSettings);
        setLogs(nextLogs);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    });
  };

  useEffect(() => {
    loadData();

    if (!isGatewayApiAvailable()) return;
    const api = getGatewayApi();

    const unsubState = api.onStateChanged((nextState) => {
      setState(nextState);
    });

    const unsubLogs = api.onLogEntry((entry) => {
      setLogs((prev) => {
        const next = [...prev, entry];
        if (next.length > 1000) {
          next.splice(0, next.length - 1000);
        }
        return next;
      });
    });

    return () => {
      unsubState();
      unsubLogs();
    };
  }, []);

  return {
    state,
    keys,
    settings,
    logs,
    isLoading,
    error,
    isPending,
    refresh: loadData,
  };
}
