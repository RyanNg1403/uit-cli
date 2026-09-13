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
  getAuthenticatedUserProfile?(userId: number): Promise<MoodleRecord>;
  uploadFile(filepath: string): Promise<MoodleRecord>;
  downloadFile(fileUrl: string, destPath: string, options?: { atomic?: boolean }): Promise<{ sha256: string } | void>;
}
