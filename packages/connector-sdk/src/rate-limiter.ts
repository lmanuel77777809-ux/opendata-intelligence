/**
 * Limitador de peticiones por host: respeta un máximo por segundo y otro por hora
 * (ventana deslizante). Reloj y espera inyectables para poder probarlo sin esperas reales.
 */
export interface RateLimit {
  perSecond?: number | undefined;
  perHour?: number | undefined;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export class HostRateLimiter {
  private readonly minIntervalMs: number;
  private readonly perHour: number | undefined;
  private readonly clock: Clock;
  private lastStart = Number.NEGATIVE_INFINITY;
  private readonly hourWindow: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(limit: RateLimit, clock: Clock = realClock) {
    this.minIntervalMs = limit.perSecond ? 1000 / limit.perSecond : 0;
    this.perHour = limit.perHour;
    this.clock = clock;
  }

  /** Espera hasta que se pueda lanzar la siguiente petición. Las llamadas se atienden en orden. */
  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      while (this.hourWindow.length > 0 && now - this.hourWindow[0]! >= 3_600_000) this.hourWindow.shift();

      let waitMs = Math.max(0, this.lastStart + this.minIntervalMs - now);
      if (this.perHour !== undefined && this.hourWindow.length >= this.perHour) {
        waitMs = Math.max(waitMs, this.hourWindow[0]! + 3_600_000 - now);
      }
      if (waitMs <= 0) {
        this.lastStart = now;
        this.hourWindow.push(now);
        return;
      }
      await this.clock.sleep(waitMs);
    }
  }
}
