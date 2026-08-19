import crypto from "crypto";

const ISSUER = (process.env.RENDER_EXTERNAL_URL || "https://truffles-guest-mcp.onrender.com").replace(/\/$/, "");
const RESOURCE = `${ISSUER}/mcp`;

const clients = new Map();
const codes = new Map();
const refreshTokens = new Map();

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function randomId(n = 24) {
  return b64url(crypto.randomBytes(n));
}

function pkceOk(verifier, challenge) {
  if (!challenge) return true;
  const digest = crypto.createHash("sha256").update(String(verifier || ""), "ascii").digest();
  return b64url(digest) === String(challenge);
}

export function asMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: ["mcp"],
    client_id_metadata_document_supported: true
  };
}

export function prMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"]
  };
}

export function mountOAuth(app) {
  const metaAs = asMetadata();
  const metaPr = prMetadata();

  app.get("/.well-known/oauth-authorization-server", (_req, res) => res.json(metaAs));
  app.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => res.json(metaAs));
  app.get("/.well-known/oauth-protected-resource", (_req, res) => res.json(metaPr));
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => res.json(metaPr));

  clients.set("truffles-claude", {
    client_id: "truffles-claude",
    client_secret: "public",
    redirect_uris: [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback"
    ],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none"
  });

  const register = (req, res) => {
    const body = req.body || {};
    const client_id = randomId(16);
    const client_secret = randomId(24);
    const redirect_uris = Array.isArray(body.redirect_uris) && body.redirect_uris.length
      ? body.redirect_uris
      : ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"];
    const grant_types = ["authorization_code", "refresh_token"];
    clients.set(client_id, {
      client_id,
      client_secret,
      redirect_uris,
      grant_types,
      token_endpoint_auth_method: body.token_endpoint_auth_method || "none"
    });
    res.status(201).json({
      client_id,
      client_secret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris,
      grant_types,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: body.client_name || "Claude"
    });
  };

  app.post("/oauth/register", register);
  app.post("/register", register);

  app.get("/oauth/authorize", (req, res) => {
    const q = req.query || {};
    const redirect_uri = String(q.redirect_uri || "");
    const state = String(q.state || "");
    const client_id = String(q.client_id || "");
    if (!redirect_uri) return res.status(400).send("missing redirect_uri");
    const code = randomId(18);
    codes.set(code, {
      client_id,
      redirect_uri,
      code_challenge: q.code_challenge,
      resource: q.resource || RESOURCE,
      exp: Date.now() + 5 * 60 * 1000
    });
    const next = new URL(redirect_uri);
    next.searchParams.set("code", code);
    if (state) next.searchParams.set("state", state);
    res.redirect(302, next.toString());
  });

  app.post("/oauth/token", (req, res) => {
    const body = req.body || {};
    const grant = String(body.grant_type || "");
    if (grant === "refresh_token") {
      const rec = refreshTokens.get(String(body.refresh_token || ""));
      if (!rec) return res.status(400).json({ error: "invalid_grant" });
      const access_token = randomId(32);
      return res.json({
        access_token,
        token_type: "Bearer",
        expires_in: 86400,
        refresh_token: body.refresh_token,
        scope: "mcp"
      });
    }
    if (grant !== "authorization_code") {
      return res.status(400).json({ error: "unsupported_grant_type" });
    }
    const rec = codes.get(String(body.code || ""));
    if (!rec || rec.exp < Date.now()) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    codes.delete(String(body.code || ""));
    if (rec.redirect_uri && body.redirect_uri && rec.redirect_uri !== body.redirect_uri) {
      return res.status(400).json({ error: "invalid_grant" });
    }
    if (!pkceOk(body.code_verifier, rec.code_challenge)) {
      return res.status(400).json({ error: "invalid_grant", error_description: "pkce" });
    }
    const access_token = randomId(32);
    const refresh_token = randomId(32);
    refreshTokens.set(refresh_token, { client_id: rec.client_id });
    res.json({
      access_token,
      token_type: "Bearer",
      expires_in: 86400,
      refresh_token,
      scope: "mcp"
    });
  });
}

export { ISSUER, RESOURCE };
