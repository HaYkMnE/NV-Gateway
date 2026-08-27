import { isChildKeyProjection, type ChildKeyProjection } from "./state-ownership";

interface ChildIpc {
  connected?: boolean;
  on(event: "message", listener: (message: unknown) => void): unknown;
  send?(message: unknown): unknown;
}

export function createPrivateStateChannel(options: { initialState: unknown; persist(state: ChildKeyProjection): void }) {
  let authenticated = false;
  let initializationSent = false;
  let challenge: string | null = null;
  return {
    get authenticated() { return authenticated; },
    get initializationSent() { return initializationSent; },
    get challenge() { return challenge; },
    attach(child: ChildIpc) {
      child.on("message", (value: any) => {
        if (!authenticated) {
          if (value?.type !== "ready" || typeof value.challenge !== "string" || value.challenge.length < 24 || value.challenge.length > 256) return;
          authenticated = true;
          challenge = value.challenge;
          initializationSent = true;
          child.send?.({ type: "state:init", challenge: value.challenge, state: options.initialState });
          return;
        }
        if (value?.type === "state:persist" && isChildKeyProjection(value.state)) options.persist(value.state);
      });
    }
  };
}
