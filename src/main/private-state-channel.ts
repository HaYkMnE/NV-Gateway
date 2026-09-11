import { isChildKeyProjection, type ChildKeyProjection } from "./state-ownership";

interface ChildIpc {
  connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  removeListener(event: "message", listener: (message: unknown) => void): unknown;
  send?(message: unknown, callback?: (error: Error | null) => void): unknown;
}

export function createPrivateStateChannel(options: { initialState: unknown; persist(state: ChildKeyProjection): void }) {
  let authenticated = false;
  let initializationSent = false;
  let initializationConfirmed = false;
  let failed = false;
  let challenge: string | null = null;
  return {
    get authenticated() { return authenticated; },
    get initializationSent() { return initializationSent; },
    get initializationConfirmed() { return initializationConfirmed; },
    get failed() { return failed; },
    get challenge() { return challenge; },
    attach(child: ChildIpc) {
      let attached = true;
      const onMessage = (value: any) => {
        if (!attached || failed) return;
        if (!authenticated) {
          if (value?.type !== "ready" || typeof value.challenge !== "string" || value.challenge.length < 24 || value.challenge.length > 256) return;
          authenticated = true;
          challenge = value.challenge;
          initializationSent = true;
          let callbackHandled = false;
          const onSend = (error: Error | null) => {
            if (callbackHandled) return;
            callbackHandled = true;
            if (!error) {
              initializationConfirmed = true;
              return;
            }
            authenticated = false;
            initializationSent = false;
            initializationConfirmed = false;
            challenge = null;
            failed = true;
          };
          try {
            if (typeof child.send !== "function") throw new Error("IPC channel is unavailable.");
            child.send({ type: "state:init", challenge: value.challenge, state: options.initialState }, onSend);
          } catch {
            onSend(new Error("IPC state initialization failed."));
          }
          return;
        }
        if (value?.type === "state:persist" && isChildKeyProjection(value.state)) options.persist(value.state);
      };
      child.on("message", onMessage);
      return () => {
        if (!attached) return;
        attached = false;
        child.removeListener("message", onMessage);
      };
    }
  };
}
