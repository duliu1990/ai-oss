/** The service-wide configuration every module reads; each module owns one OSS prefix. */
export interface ConfigResponse {
  oss_ready: boolean;
  oss_missing: string[];
  bucket: string;
  drive_prefix: string;
  note_prefix: string;
  media_prefix: string;
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

export function isConfig(value: Record<string, unknown>): value is Record<string, unknown> & ConfigResponse {
  return typeof value.oss_ready === 'boolean' && strings(value.oss_missing) && typeof value.bucket === 'string'
    && typeof value.drive_prefix === 'string' && typeof value.note_prefix === 'string'
    && typeof value.media_prefix === 'string';
}
