/** Small seam over Obsidian's requestUrl so the Dropbox client can be tested. */
export interface HttpRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  arrayBuffer: ArrayBuffer;
  text: string;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export function header(res: HttpResponse, name: string): string | undefined {
  const n = name.toLowerCase();
  for (const [k, v] of Object.entries(res.headers)) if (k.toLowerCase() === n) return v;
  return undefined;
}

/**
 * Dropbox-API-Arg travels in an HTTP header, which must be ASCII. Non-ASCII
 * characters (every Cyrillic file name!) have to be \u-escaped.
 */
export function headerSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
