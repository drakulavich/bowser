// CDP Network domain cookie types — mirrors the Chrome DevTools Protocol
// Network.Cookie and Network.CookieParam shapes verbatim.
// No runtime dependency; types only.

/** A cookie as returned by Network.getAllCookies / Network.getCookies. */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Expiry as Unix timestamp in seconds. -1 means session cookie. */
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None" | "Extended" | "Unspecified";
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
  partitionKey?: string;
}

/** Parameters for Network.setCookie. */
export interface CookieParam {
  name: string;
  value: string;
  /** One of url or domain is required. */
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Unix timestamp in seconds for expiry. Omit for session cookie. */
  expires?: number;
  priority?: "Low" | "Medium" | "High";
  sameParty?: boolean;
  sourceScheme?: "Unset" | "NonSecure" | "Secure";
  sourcePort?: number;
  partitionKey?: string;
}

/** Options for Network.deleteCookies. */
export interface DeleteCookieOptions {
  url?: string;
  domain?: string;
  path?: string;
}
