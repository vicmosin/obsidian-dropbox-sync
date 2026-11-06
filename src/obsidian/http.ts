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
  let text = "";
  try {
    text = r.text;
  } catch {
    /* binary body */
  }
  return { status: r.status, headers: r.headers, arrayBuffer: r.arrayBuffer, text };
};
