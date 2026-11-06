import type { HttpFn } from "./http";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
  accountId?: string;
}

/** Obsidian protocol action; must match the redirect URI registered with Dropbox. */
export const AUTH_ACTION = "synced-up-auth";
export const REDIRECT_URI = `obsidian://${AUTH_ACTION}`;

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createPkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** redirect=false → Dropbox shows a code the user pastes back (always works). */
export function authorizeUrl(appKey: string, challenge: string, redirect: boolean): string {
  const p = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
  });
  if (redirect) p.set("redirect_uri", REDIRECT_URI);
  return `https://www.dropbox.com/oauth2/authorize?${p}`;
}

async function tokenRequest(http: HttpFn, params: Record<string, string>) {
  const res = await http({
    url: "https://api.dropboxapi.com/oauth2/token",
    method: "POST",
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(params).toString(),
  });
  if (res.status !== 200) throw new Error(`Dropbox auth failed (${res.status}): ${res.text}`);
  return JSON.parse(res.text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    account_id?: string;
  };
}

export async function exchangeCode(
  http: HttpFn,
  appKey: string,
  code: string,
  verifier: string,
  redirect: boolean,
): Promise<Tokens> {
  const params: Record<string, string> = {
    code: code.trim(),
    grant_type: "authorization_code",
    client_id: appKey,
    code_verifier: verifier,
  };
  if (redirect) params.redirect_uri = REDIRECT_URI;
  const j = await tokenRequest(http, params);
  if (!j.refresh_token) throw new Error("Dropbox did not return a refresh token");
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: Date.now() + j.expires_in * 1000,
    accountId: j.account_id,
  };
}

export async function refreshTokens(http: HttpFn, appKey: string, t: Tokens): Promise<Tokens> {
  const j = await tokenRequest(http, {
    grant_type: "refresh_token",
    refresh_token: t.refreshToken,
    client_id: appKey,
  });
  return { ...t, accessToken: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
}
