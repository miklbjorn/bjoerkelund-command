// Admin panels. Each panel owns its routes, tables (prefixed with its id) and optional cron.

import type { Env } from "../index";
import type { AdminIdentity } from "../auth/access";
import { heatingCron } from "./heating/cron";
import { heatingRoutes } from "./heating/routes";

export type Panel = {
  id: string;
  title: string;
  description: string;
  // Called for /admin/<id>* and /api/admin/<id>/* after authentication; null means "not mine".
  routes: (request: Request, env: Env, url: URL, admin: AdminIdentity) => Promise<Response | null>;
  cron?: (env: Env) => Promise<void>;
};

export const panels: Panel[] = [
  {
    id: "heating",
    title: "Heating",
    description: "Heat pump frost protection via tado°",
    routes: heatingRoutes,
    cron: heatingCron,
  },
];
