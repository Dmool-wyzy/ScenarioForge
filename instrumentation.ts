export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTaskScheduler } = await import("./lib/tasks");
    startTaskScheduler();
  }
}
