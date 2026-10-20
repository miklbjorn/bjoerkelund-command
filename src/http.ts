// Response helpers for the admin area. Every admin response is uncacheable and unframeable.

const CHART_JS = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";

export const ADMIN_HEADERS = {
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "content-security-policy":
    `default-src 'self'; script-src 'self' 'unsafe-inline' ${CHART_JS}; style-src 'unsafe-inline'; img-src 'self'; ` +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
  });

export const html = (body: string) =>
  new Response(body, { headers: { ...ADMIN_HEADERS, "content-type": "text/html; charset=utf-8" } });

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) return undefined;
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
