import { verifyAccess } from "./auth/access";
import { html, json } from "./http";
import { panels } from "./panels/registry";
import adminHtml from "./admin/index.html";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAILS?: string; // Worker secret, comma-separated
}

// Admin pages are bundled into the Worker, never into the public assets, so the
// only way to reach them is through the auth check below.

// Cloudflare Access does not match every encoding of a path (e.g. /admin%2F...),
// so decide "is this admin?" on a normalised path and fail closed.
function looksAdmin(pathname: string): boolean {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  p = p.toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return /^\/(api\/)?admin(\/|$)/.test(p) || p.includes("/admin/") || p.endsWith("/admin");
}

// Browsers send Origin on cross-site POSTs; reject state-changing requests from other sites.
function sameOrigin(request: Request, url: URL): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  return request.headers.get("Origin") === url.origin;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (looksAdmin(url.pathname)) {
      const admin = await verifyAccess(request, env);
      if (!admin) return new Response("Forbidden", { status: 403 });
      if (!sameOrigin(request, url)) return new Response("Forbidden", { status: 403 });

      // Exact matches on the raw path only; odd encodings fall through to 404.
      if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) {
        return html(adminHtml);
      }
      if (request.method === "GET" && url.pathname === "/api/admin/me") {
        return json({ email: admin.email, panels: panels.map(({ id, title, description }) => ({ id, title, description })) });
      }
      for (const panel of panels) {
        if (url.pathname.startsWith(`/admin/${panel.id}`) || url.pathname.startsWith(`/api/admin/${panel.id}/`)) {
          const res = await panel.routes(request, env, url, admin);
          if (res) return res;
        }
      }
      return json({ error: "not_found" }, 404);
    }

    if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env): Promise<void> {
    // One panel's failure must not stop the others.
    for (const panel of panels) {
      try {
        await panel.cron?.(env);
      } catch (err) {
        console.error(`cron ${panel.id} failed`, err);
      }
    }
  },
} satisfies ExportedHandler<Env>;
