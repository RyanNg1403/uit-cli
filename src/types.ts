export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type MoodleRecord = Record<string, any>;

export interface ApiClient {
  call<T = any>(name: string, params?: Record<string, any>): Promise<T>;
  uploadFile(filepath: string): Promise<MoodleRecord>;
  downloadFile(fileUrl: string, destPath: string, options?: { atomic?: boolean }): Promise<{ sha256: string } | void>;
}
