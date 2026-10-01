/**
 * Time abstraction (CLAUDE.md §3.4/§3.6, SDD §9.13, §19.3). Every service takes time
 * from an injected Clock — never calls `Date.now()`/`new Date()` directly — so the
 * same code is deterministic under FakeClock in tests. This is foundation
 * infrastructure, not business logic: it has no opinion about *what* time means to
 * HAVEN (that's the rules engine, built in M3), only about how time is obtained.
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(date: Date): void {
    this.current = date;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
