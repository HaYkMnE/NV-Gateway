// Pure logic for the Settings «Request deadline» field (Е-1b). The UI edits
// whole SECONDS; main stores/validates milliseconds (1..1800000).
export const DEADLINE_DEFAULT_SECONDS = 240;
export const DEADLINE_MIN_SECONDS = 1;
export const DEADLINE_MAX_SECONDS = 1800;
export const DEADLINE_ENV_NAME = 'GATEWAY_REQUEST_DEADLINE_MS';

export type DeadlineValidation = null | 'required' | 'integer' | 'range';

// Same codes as validateGatewayPort (port_* keys) -> deadline_* keys.
// Only plain ASCII digits count as an integer ("1e3", "0x10", "1.5" do not).
export function validateDeadlineSeconds(value: string): DeadlineValidation {
  const trimmed = value.trim();
  if (trimmed === '') return 'required';
  if (!/^-?[0-9]+$/.test(trimmed)) return 'integer';
  const seconds = Number(trimmed);
  return seconds >= DEADLINE_MIN_SECONDS && seconds <= DEADLINE_MAX_SECONDS ? null : 'range';
}

// Returns the ms value to send, or null when the input must NOT be sent.
export function deadlineSecondsToMs(value: string): number | null {
  if (validateDeadlineSeconds(value) !== null) return null;
  return Number(value.trim()) * 1000;
}

// Effective ms (from runtime state) -> seconds text; non-whole seconds are shown as-is (1500 -> "1.5").
export function formatDeadlineSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return String(DEADLINE_DEFAULT_SECONDS);
  return String(ms / 1000);
}

export function deadlineDescribedBy(shown: { error: boolean; env: boolean }): string {
  return ['request-deadline-help', shown.error && 'request-deadline-error', shown.env && 'request-deadline-env'].filter(Boolean).join(' ');
}

// Splits an already-interpolated message around the first occurrence of `name`
// so the name can be wrapped in an LTR <bdi>. null when the name is absent.
export function splitAtPlaceholder(text: string, name: string): [string, string] | null {
  const index = text.indexOf(name);
  if (index < 0) return null;
  return [text.slice(0, index), text.slice(index + name.length)];
}
