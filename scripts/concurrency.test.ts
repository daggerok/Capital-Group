/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { createRequestGate, fetchWithRetry, withRequestLane } from './update-data';

// Virtual time proves reservations use the SAME lane after early/late wakeups.
test('lane queue spaces simultaneous callers and never catches up after a late timer', async () => {
  let now = 0;
  const waits: number[] = [], starts: number[] = [];
  const gate = createRequestGate(100, {
    now: () => now,
    sleep: async ms => { waits.push(ms); now += ms + (waits.length === 1 ? 250 : 0); },
  });
  await Promise.all(Array.from({ length: 4 }, async () => { await gate(); starts.push(now); }));
  expect(starts).toEqual([0, 350, 450, 550]);
  expect(waits).toEqual([100, 100, 100]);
});

test('early timers are rechecked, zero sleep is immediate, independent gates have no shared tail', async () => {
  let now = 0, sleeps = 0;
  const gate = createRequestGate(100, {
    now: () => now,
    sleep: async ms => { now += ++sleeps === 1 ? ms - 10 : ms; },
  });
  await gate(); await gate();
  expect(now).toBe(100); expect(sleeps).toBe(2);
  const zero = createRequestGate(0, { now: () => now, sleep: async () => { throw new Error('unexpected sleep'); } });
  await zero(); await zero();
  let release!: () => void;
  const blocked = createRequestGate(100, { now: () => now, sleep: async ms => { await new Promise<void>(r => { release = r; }); now += ms; } });
  await blocked(); const pending = blocked();
  await Promise.resolve();
  await zero(); // Another lane does not join the blocked lane's queue.
  expect(typeof release).toBe('function'); release(); await pending;
});

test('failed timer does not poison its lane queue', async () => {
  let now = 0, fail = true;
  const gate = createRequestGate(100, { now: () => now, sleep: async ms => {
    if (fail) { fail = false; throw new Error('timer failure'); }
    now += ms;
  } });
  await gate(); await expect(gate()).rejects.toThrow('timer failure'); await gate();
  expect(now).toBe(100);
});

test('real HTTP: 1, 3 and 15 worker lanes overlap requests, retain spacing across funds, and improve throughput', async () => {
  const starts = new Map<string, number[]>();
  let active = 0, peak = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const lane = new URL(request.url).pathname.split('/')[1]!;
    const times = starts.get(lane) ?? []; times.push(performance.now()); starts.set(lane, times);
    peak = Math.max(peak, ++active);
    await Bun.sleep(20); active--;
    return new Response('ok');
  } });
  try {
    const durations: number[] = [];
    for (const concurrency of [1, 3, 15]) {
      starts.clear(); peak = 0;
      const funds = Array.from({ length: 15 }, (_, i) => i);
      const before = performance.now();
      await Promise.all(Array.from({ length: concurrency }, (_, lane) => withRequestLane(60, async () => {
        while (funds.length) {
          const fund = funds.shift()!;
          for (let request = 0; request < 3; request++) {
            const response = await fetchWithRetry(`${server.url}${lane}/${fund}/${request}`, 'local pacing regression', {}, 0);
            expect(await response.text()).toBe('ok');
          }
        }
      })));
      durations.push(performance.now() - before);
      expect(starts.size).toBe(concurrency);
      expect(peak).toBe(concurrency);
      expect([...starts.values()].reduce((n, times) => n + times.length, 0)).toBe(45);
      // These are server ARRIVALS, not client starts: allow connection jitter.
      for (const times of starts.values()) {
        for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(40);
      }
    }
    // Wide ratio tolerance for busy CI; the former global gate cannot pass.
    expect(durations[1]!).toBeLessThan(durations[0]! * 0.65);
    expect(durations[2]!).toBeLessThan(durations[0]! * 0.3);
    console.log('[ concurrency test ] HTTP durations ms (1/3/15 lanes):', durations.map(Math.round).join('/'));
  } finally { server.stop(true); }
}, 15000);

test('retry and non-retryable failures stay in their own lane without stalling other workers', async () => {
  const starts = new Map<string, number[]>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const lane = new URL(request.url).pathname.slice(1);
    const times = starts.get(lane) ?? []; times.push(performance.now()); starts.set(lane, times);
    return new Response('fixture', { status: lane === 'retry' && times.length === 1 ? 429 : lane === 'terminal' ? 404 : 200 });
  } });
  try {
    await Promise.all([
      withRequestLane(60, async () => {
        const result = await fetchWithRetry(`${server.url}retry`, 'retry fixture', {}, 1);
        expect(result.status).toBe(200); await result.text();
      }),
      withRequestLane(60, async () => {
        await expect(fetchWithRetry(`${server.url}terminal`, 'terminal fixture', {}, 2)).rejects.toThrow('HTTP 404');
        const result = await fetchWithRetry(`${server.url}healthy`, 'healthy fixture', {}, 0); await result.text();
      }),
    ]);
    expect(starts.get('terminal')!.length).toBe(1);
    expect(starts.get('retry')!.length).toBe(2);
    expect(starts.get('retry')![1]! - starts.get('retry')![0]!).toBeGreaterThanOrEqual(60);
    expect(starts.get('healthy')![0]! - starts.get('terminal')![0]!).toBeGreaterThanOrEqual(40);
    expect(starts.get('healthy')![0]!).toBeLessThan(starts.get('retry')![1]!);
  } finally { server.stop(true); }
}, 5000);
