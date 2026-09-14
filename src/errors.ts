export type AudioErrorCode =
  | 'FILE_ERROR'
  | 'DECODE_ERROR'
  | 'DEVICE_ERROR'
  | 'ENGINE_ERROR'
  | 'UNSUPPORTED_PLATFORM'
  | 'PLAYBACK_LIMIT'
  | 'PLAYER_CLOSED'
  | 'TIMEOUT';

/** An operational failure. Invalid arguments instead throw TypeError/RangeError. */
export class AudioError extends Error {
  override readonly name = 'AudioError';

  constructor(
    readonly code: AudioErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
