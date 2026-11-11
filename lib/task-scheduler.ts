type IntervalHandle = ReturnType<typeof setInterval>;
export type TaskSchedulerState = {
  scenarioforgeScheduler?: IntervalHandle;
  scenarioforgeSchedulerVersion?: number;
  scenarioforgeTaskTick?: () => Promise<void>;
  scenarioforgeTick?: boolean;
};

const VERSION = 2;
const timers = { setInterval, clearInterval };

// Keep the callback on shared process state: Next dev can replace this module
// while an interval from an earlier server bundle remains alive.
export function refreshTaskScheduler(state: TaskSchedulerState, tick: () => Promise<void>, onError: (error: unknown) => void, enabled: boolean, clock = timers) {
  state.scenarioforgeTaskTick = tick;
  if (!enabled) {
    if (state.scenarioforgeScheduler) clock.clearInterval(state.scenarioforgeScheduler);
    delete state.scenarioforgeScheduler;
    delete state.scenarioforgeSchedulerVersion;
    return;
  }
  if (state.scenarioforgeScheduler && state.scenarioforgeSchedulerVersion === VERSION) return;
  if (state.scenarioforgeScheduler) clock.clearInterval(state.scenarioforgeScheduler);
  state.scenarioforgeScheduler = clock.setInterval(() => {
    void state.scenarioforgeTaskTick?.().catch(onError);
  }, 3000);
  state.scenarioforgeSchedulerVersion = VERSION;
  state.scenarioforgeScheduler.unref();
}
