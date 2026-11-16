import { createApp } from './app.ts';

// Each phase gets its own retry clock. Requests time out independently of the
// backoff, so a slow environment cannot leave registration or polling stuck.
async function repeatUntilAccepted(operation: () => Promise<boolean>): Promise<void> {
  let failures = 0;
  while (!(await operation())) {
    const delay = Math.min(2_000, 250 * 2 ** Math.min(failures++, 8));
    await new Promise<void>(resolve => setTimeout(resolve, delay));
  }
}

async function announcePort(origin: string, port: number): Promise<void> {
  await repeatUntilAccepted(async () => {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      switch (response.status) {
        case 200:
        case 409:
          return true;
        case 400:
        case 405:
          throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      // Contract rejection is fatal; transport failures can recover on retry.
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    return false;
  });
}

async function awaitTrialCompletion(origin: string): Promise<void> {
  await repeatUntilAccepted(async () => {
    try {
      const response = await fetch(`${origin}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) return (await response.json()).done === true;
    } catch {
      // Missing, malformed and timed-out answers do not end the trial.
    }
    return false;
  });
}

async function serveTrial(): Promise<void> {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (!origin) throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  // app.ts owns routing, including the public /healthz readiness probe.
  const forge = createApp(undefined, token);
  await new Promise<void>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, '127.0.0.1', resolve);
  });
  const bound = forge.address();
  if (!bound || typeof bound === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${bound.port}\n`);
  await announcePort(origin, bound.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await awaitTrialCompletion(origin);
  forge.close();
  process.stdout.write('[entry] done\n');
}

try {
  await serveTrial();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
