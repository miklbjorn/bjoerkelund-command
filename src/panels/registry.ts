// Admin panels. Each panel owns its routes, tables (prefixed with its id) and optional cron.
// Heating is added in Phase 3.

export type Panel = {
  id: string;
  title: string;
  description: string;
  cron?: (env: unknown) => Promise<void>;
};

export const panels: Panel[] = [];
