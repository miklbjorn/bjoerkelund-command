// Admin panels. Each panel owns its routes, tables (prefixed with its id) and optional cron.

import type { Env } from "../index";
import type { AdminIdentity } from "../auth/access";
import { heatingCron } from "./heating/cron";
import { heatingRoutes, heatingSummary } from "./heating/routes";

// Shown on the dashboard tile. `ok` is true only when the panel is running as planned.
export type PanelSummary = {
  ok: boolean;
  label: string;
  stats: { label: string; value: string }[];
};

export type Panel = {
  id: string;
  title: string;
  description: string;
  // Called for /admin/<id>* and /api/admin/<id>/* after authentication; null means "not mine".
  routes: (request: Request, env: Env, url: URL, admin: AdminIdentity) => Promise<Response | null>;
  summary?: (env: Env) => Promise<PanelSummary>;
  cron?: (env: Env) => Promise<void>;
};

export const panels: Panel[] = [
  {
    id: "heating",
    title: "Heating",
    description: "Heat pump frost protection via tado°",
    routes: heatingRoutes,
    summary: heatingSummary,
    cron: heatingCron,
  },
];
