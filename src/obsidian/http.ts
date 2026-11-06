import { requestUrl } from "obsidian";
import type { HttpFn } from "../dropbox/http";

/** requestUrl bypasses CORS and works on iOS, unlike fetch to Dropbox. */
export const obsidianHttp: HttpFn = async (req) => {
  const r = await requestUrl({
    url: req.url,
    method: req.method,
    headers: req.headers,
    body: req.body,
    contentType: req.contentType,
    throw: false,
  });
  let text: string | undefined;
  return {
    status: r.status,
    headers: r.headers,
    arrayBuffer: r.arrayBuffer,
    // Decoding a large binary download as text wastes memory, so only do it
    // for callers that read it (JSON replies and error messages).
    get text(): string {
      if (text === undefined) {
        try {
          text = r.text;
        } catch {
          text = "";
        }
      }
      return text;
    },
  };
};
