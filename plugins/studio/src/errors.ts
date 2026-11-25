export type ErrorCode =
  | 'MODE_INVALID'
  | 'CONFIG_INVALID'
  | 'KEY_MISSING'
  | 'KEY_UNSAFE'
  | 'BRIEF_INVALID'
  | 'NOT_APPROVED'
  | 'APPROVAL_STALE'
  | 'CAP_EXCEEDED'
  | 'ATTEMPT_UNRESOLVED'
  | 'LAST_ATTEMPT_FAILED'
  | 'INPUT_REFUSED'
  | 'LOCKED'
  | 'FILE_BUSY'
  | 'MODEL_NOT_ALLOWED'
  | 'ASSET_LICENSE_MISSING'
  | 'KEYFRAME_NOT_CONFIRMED'
  | 'RAW_STALE'
  | 'PROVIDER_ERROR'
  | 'PRICE_CHANGED'
  | 'DOWNLOAD_REJECTED'
  | 'WAIT_TIMEOUT'
  | 'VOICE_MISSING'
  | 'SCENE_FAILED'
  | 'WORK_EXISTS'
  | 'NOT_FOUND'
  | 'USAGE'
  | 'UNEXPECTED';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export class StudioError extends Error {
  override readonly name = 'StudioError';
  readonly code: ErrorCode;
  // `declare` keeps the field off the instance when absent, instead of an own `details: undefined`.
  declare readonly details?: JsonValue;

  constructor(code: ErrorCode, message: string, details?: JsonValue) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
