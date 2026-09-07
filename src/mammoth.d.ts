declare module "mammoth" {
  export interface MammothResult {
    value: string;
    messages: unknown[];
  }
  export function extractRawText(input: { buffer: Buffer } | { path: string }): Promise<MammothResult>;
  const mammoth: {
    extractRawText: typeof extractRawText;
  };
  export default mammoth;
}
