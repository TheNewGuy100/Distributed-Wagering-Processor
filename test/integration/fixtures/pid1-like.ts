// Starts the application the way a container does: as PID 1.
//
// The kernel gives PID 1 no default action for signals, so the SIGTERM that Nest re-raises after its shutdown
// hooks is ignored and the process ends only when nothing keeps its event loop alive. A no-op listener registered
// BEFORE the app boots reproduces that, which makes a leaked timer or open handle visible as a slow exit.
process.on('SIGTERM', () => {});
await import('../../../src/main');

export {};
