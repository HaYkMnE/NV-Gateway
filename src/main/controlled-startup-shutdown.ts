export interface ControlledStartupShutdownOptions {
  setControlled(): void;
  setExitCode(exitCode: number): void;
  quit(): void;
}

export interface ControlledStartupShutdown {
  close(exitCode: number): void;
  isControlled(): boolean;
}

/** Keeps expected explicit-command closure out of the normal shutdown path. */
export function createControlledStartupShutdown(options: ControlledStartupShutdownOptions): ControlledStartupShutdown {
  let closed = false;
  return {
    close(exitCode: number) {
      if (closed) return;
      closed = true;
      options.setControlled();
      options.setExitCode(exitCode);
      options.quit();
    },
    isControlled() {
      return closed;
    }
  };
}
