// Trace WHERE test-chat-route hangs: run its sections one by one.
process.env.DSH_HOME = process.env.DSH_HOME; // keep
const origLog = console.log;
const t0 = Date.now();
const trace = (m) => origLog(`[${String(Date.now() - t0).padStart(6)}ms] ${m}`);
console.log = trace;

const mod = await import('./test-chat-route.mjs');
