// Why: repo housekeeping is unrelated to ref freshness; per-command config also works on old Git.
// Cover both modern maintenance and its legacy auto-gc predecessor without changing user config.
export const GIT_FETCH_SKIP_AUTO_MAINTENANCE_CONFIG_ARGS = [
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0'
] as const
