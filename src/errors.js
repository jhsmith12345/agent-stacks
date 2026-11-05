export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requireThat(condition, code, message) {
  if (!condition) throw new ProtocolError(code, message);
}
export function integer(value, min, max, name) {
  requireThat(Number.isSafeInteger(value) && value >= min && value <= max,
    'INVALID_ARGUMENT', `${name} must be an integer from ${min} to ${max}`);
  return value;
}
