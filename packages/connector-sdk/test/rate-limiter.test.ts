import { describe, expect, it } from 'vitest';
import { HostRateLimiter, type Clock } from '../src/rate-limiter.ts';

function fakeClock(): Clock & { starts: number[] } {
  let now = 0;
  return {
    starts: [],
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

describe('HostRateLimiter', () => {
  it('espacia las peticiones según el límite por segundo', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({ perSecond: 4 }, clock);
    const starts: number[] = [];
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
      starts.push(clock.now());
    }
    expect(starts).toEqual([0, 250, 500, 750, 1000]);
  });

  it('respeta el cupo por hora con ventana deslizante', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({ perHour: 3 }, clock);
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await limiter.acquire();
      starts.push(clock.now());
    }
    expect(starts).toEqual([0, 0, 0, 3_600_000]);
  });

  it('atiende las llamadas concurrentes en orden', async () => {
    const clock = fakeClock();
    const limiter = new HostRateLimiter({ perSecond: 1 }, clock);
    const order: number[] = [];
    await Promise.all([0, 1, 2].map((i) => limiter.acquire().then(() => order.push(i))));
    expect(order).toEqual([0, 1, 2]);
    expect(clock.now()).toBe(2_000);
  });
});
