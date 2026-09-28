// Measurement only: forwards real fetch unchanged. Never captures headers/cookies/bodies.
import { appendFileSync } from 'node:fs';
const realFetch = globalThis.fetch;
const started = performance.now();
let id = 0, active = 0;
globalThis.fetch = async (...args) => {
  const request = ++id, startMs = performance.now() - started;
  const url = String(args[0]);
  active++;
  appendFileSync('request-trace.jsonl', JSON.stringify({event:'start',request,startMs,url,active})+'\n');
  try {
    const response = await realFetch(...args);
    appendFileSync('request-trace.jsonl', JSON.stringify({event:'response',request,atMs:performance.now()-started,status:response.status})+'\n');
    return response;
  } catch (error) {
    appendFileSync('request-trace.jsonl', JSON.stringify({event:'error',request,atMs:performance.now()-started,error:String(error)})+'\n');
    throw error;
  } finally { active--; }
};
