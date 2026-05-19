/**
 * Shared iNaturalist API v1 helpers (JWT from https://www.inaturalist.org/users/api_token ).
 * Used by the observation explorer and the square-crop tool — same localStorage keys.
 */

export const INAT_API_V1 = "https://api.inaturalist.org/v1";

/** Browser-local storage key for the iNaturalist API JWT. */
export const INAT_API_JWT_STORAGE_KEY = "inatExplorerApiJwt";
/** When set to `"1"`, send `Authorization: Bearer <jwt>` (some environments expect the scheme). */
export const INAT_API_JWT_BEARER_MODE_KEY = "inatExplorerApiJwtUseBearer";

export function getStoredInatApiJwt() {
  try {
    const raw = localStorage.getItem(INAT_API_JWT_STORAGE_KEY);
    return raw == null ? "" : String(raw).trim();
  } catch {
    return "";
  }
}

/**
 * Trim and strip a leading `Bearer` scheme from a pasted or stored token string.
 * @param {string} raw
 */
function normalizeInatApiJwtInput(raw) {
  let t = String(raw || "").trim();
  if (!t) return "";
  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, "").trim();
  return t;
}

/** Decode one JWT segment from base64url; returns UTF-8 string or `null`. */
function tryDecodeJwtSegment(segment) {
  try {
    const s = String(segment);
    const padLen = (4 - (s.length % 4)) % 4;
    const pad = "=".repeat(padLen);
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return atob(b64);
  } catch {
    return null;
  }
}

/**
 * Client-side JWT format check: three base64url segments and decodable JSON header with `alg`.
 * @returns {{ ok: true, token: string } | { ok: false, error: string }}
 */
export function validateInatJwtFormat(candidate) {
  let t = String(candidate || "").trim();
  if (!t) return { ok: false, error: "Token is empty after trimming." };
  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, "").trim();
  const parts = t.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `Not a valid JWT shape (expected three dot-separated segments; found ${parts.length}).`,
    };
  }
  const b64u = /^[A-Za-z0-9_-]+$/;
  for (let i = 0; i < 3; i += 1) {
    if (!parts[i]) return { ok: false, error: `JWT segment ${i + 1} is empty.` };
    if (!b64u.test(parts[i])) {
      return {
        ok: false,
        error: `JWT segment ${i + 1} must use only base64url characters (A–Z a–z 0–9 _ -).`,
      };
    }
  }
  const headerJson = tryDecodeJwtSegment(parts[0]);
  if (headerJson == null) {
    return { ok: false, error: "Could not base64url-decode the JWT header (first segment)." };
  }
  let header;
  try {
    header = JSON.parse(headerJson);
  } catch {
    return { ok: false, error: "JWT header is not valid JSON after decoding." };
  }
  if (!header || typeof header !== "object") {
    return { ok: false, error: "JWT header must decode to a JSON object." };
  }
  if (typeof header.alg !== "string" || !header.alg.trim()) {
    return { ok: false, error: 'Decoded JWT header must include a string "alg" field.' };
  }
  return { ok: true, token: t };
}

/** Typical JWT shape: three dot-separated segments (before full validation). */
function looksLikeJwtPayload(token) {
  const t = String(token || "").trim();
  return t.split(".").length >= 3;
}

/**
 * Find the first JWT-shaped string in parsed JSON (iNat token pages often wrap the JWT in JSON).
 * @param {any} val
 * @param {number} depth
 * @returns {string | null}
 */
function extractJwtStringFromJsonValue(val, depth = 0) {
  if (depth > 10) return null;

  if (typeof val === "string") {
    const s = normalizeInatApiJwtInput(val);
    if (!s || !looksLikeJwtPayload(s)) return null;
    return s;
  }

  if (!val || typeof val !== "object") return null;

  if (Array.isArray(val)) {
    for (const item of val) {
      const f = extractJwtStringFromJsonValue(item, depth + 1);
      if (f) return f;
    }
    return null;
  }

  const PRIORITY_KEYS = ["api_token", "access_token", "token", "jwt", "id_token"];
  for (const k of PRIORITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(val, k)) {
      const f = extractJwtStringFromJsonValue(val[k], depth + 1);
      if (f) return f;
    }
  }

  const NEST_KEYS = ["credentials", "data", "result", "token_response", "oauth"];
  for (const k of NEST_KEYS) {
    if (val[k] != null && typeof val[k] === "object") {
      const f = extractJwtStringFromJsonValue(val[k], depth + 1);
      if (f) return f;
    }
  }

  for (const k of Object.keys(val)) {
    if (PRIORITY_KEYS.includes(k) || NEST_KEYS.includes(k)) continue;
    const f = extractJwtStringFromJsonValue(val[k], depth + 1);
    if (f) return f;
  }
  return null;
}

/**
 * Parse Apply-field content: full JSON from the API token page, or a raw JWT string.
 * @returns {{ token: string, error: null } | { token: null, error: string }}
 */
export function parseInatApiTokenPaste(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return { token: null, error: "Paste the JSON from the API token page or a raw JWT, then Apply." };
  }

  let candidate = null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data;
    try {
      data = JSON.parse(trimmed);
    } catch (e) {
      const msg = e && typeof e.message === "string" ? e.message : String(e);
      return { token: null, error: `Invalid JSON: ${msg}` };
    }
    candidate = extractJwtStringFromJsonValue(data, 0);
    if (!candidate) {
      return {
        token: null,
        error:
          "JSON did not contain a JWT string. Expected a field such as api_token, access_token, or token (nested objects like credentials are searched).",
      };
    }
  } else {
    candidate = trimmed;
  }

  const v = validateInatJwtFormat(candidate);
  if (!v.ok) return { token: null, error: v.error };
  return { token: v.token, error: null };
}

/** Store a JWT that already passed {@link parseInatApiTokenPaste} / {@link validateInatJwtFormat}. */
export function persistParsedInatApiJwt(canonicalToken) {
  const v = validateInatJwtFormat(canonicalToken);
  if (!v.ok) return { ok: false, error: v.error || "Invalid token." };
  try {
    localStorage.setItem(INAT_API_JWT_STORAGE_KEY, v.token);
    localStorage.removeItem(INAT_API_JWT_BEARER_MODE_KEY);
  } catch {
    return { ok: false, error: "Could not save the token (browser storage may be disabled or full)." };
  }
  return { ok: true };
}

export function clearStoredInatApiJwt() {
  try {
    localStorage.removeItem(INAT_API_JWT_STORAGE_KEY);
    localStorage.removeItem(INAT_API_JWT_BEARER_MODE_KEY);
  } catch {
    /* ignore */
  }
}

/** Value for the `Authorization` request header when using a stored JWT. */
export function inatApiJwtAuthorizationValue() {
  const jwt = normalizeInatApiJwtInput(getStoredInatApiJwt());
  if (!jwt) return "";
  let useBearer = false;
  try {
    useBearer = localStorage.getItem(INAT_API_JWT_BEARER_MODE_KEY) === "1";
  } catch {
    useBearer = false;
  }
  return useBearer ? `Bearer ${jwt}` : jwt;
}

/**
 * Read the response body (consumes it) and return a single-line diagnostic for display.
 * @param {Response} res
 */
export async function formatInatHttpErrorForDisplay(res) {
  const status = res.status || 0;
  let text = "";
  try {
    text = await res.text();
  } catch (err) {
    const msg = err && typeof err.message === "string" ? err.message : String(err);
    return `HTTP ${status} (could not read response body: ${msg})`;
  }
  const trimmed = text.trim();
  if (!trimmed) return `HTTP ${status} (empty response body)`;
  try {
    return `HTTP ${status}: ${JSON.stringify(JSON.parse(trimmed))}`;
  } catch {
    return `HTTP ${status}: ${trimmed}`;
  }
}

/**
 * `GET /users/me` with the stored token; on 401 tries `Bearer <jwt>` once for JWT-shaped tokens
 * and remembers that mode when it succeeds.
 * @returns {Promise<Response>}
 */
export async function fetchUsersMeWithStoredJwt() {
  let res = await inatFetch("users/me", { auth: true });
  if (res.ok) return res;

  let useBearer = false;
  try {
    useBearer = localStorage.getItem(INAT_API_JWT_BEARER_MODE_KEY) === "1";
  } catch {
    useBearer = false;
  }

  const jwt = normalizeInatApiJwtInput(getStoredInatApiJwt());
  if (!jwt) return res;

  if (res.status === 401 && useBearer) {
    const resRaw = await inatFetch("users/me", { headers: { Authorization: jwt } });
    if (resRaw.ok) {
      try {
        localStorage.removeItem(INAT_API_JWT_BEARER_MODE_KEY);
      } catch {
        /* ignore */
      }
    }
    return resRaw;
  }

  if (res.status === 401 && !useBearer && looksLikeJwtPayload(jwt)) {
    const resBearer = await inatFetch("users/me", { headers: { Authorization: `Bearer ${jwt}` } });
    if (resBearer.ok) {
      try {
        localStorage.setItem(INAT_API_JWT_BEARER_MODE_KEY, "1");
      } catch {
        /* ignore */
      }
      return resBearer;
    }
    return resBearer;
  }
  return res;
}

/**
 * Fetch from api.inaturalist.org with `cache: "no-store"` and a unique query param so browsers and
 * intermediaries do not return stale JSON or tiles after Refresh or bfcache restore.
 * @param {string} pathAndQuery Path under /v1/, e.g. `observations?taxon_id=1&per_page=20` or `taxa/48561`
 * @param {{ method?: string, body?: BodyInit | null, headers?: Record<string, string>, auth?: boolean }} [options]
 */
export function inatFetch(pathAndQuery, options = {}) {
  const trimmed = pathAndQuery.replace(/^\//, "");
  const u = new URL(trimmed, `${INAT_API_V1}/`);
  u.searchParams.set("_cb", `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`);
  /** @type {RequestInit} */
  const init = { cache: "no-store" };
  if (options.method) init.method = options.method;
  if (options.body != null) init.body = options.body;
  const headers = { ...(options.headers || {}) };
  if (options.auth) {
    const authVal = inatApiJwtAuthorizationValue();
    if (authVal) headers.Authorization = authVal;
  }
  if (Object.keys(headers).length) init.headers = headers;
  return fetch(u.href, init);
}
