/**
 * SubTrans Extension — Disposer: gom toàn bộ tài nguyên cần dọn dẹp (PLAN Phase 6 "Quy tắc dọn dẹp").
 * - signal: truyền vào mọi addEventListener({ signal }) để gỡ listener bằng 1 lệnh abort().
 * - add/timeout/interval/raf/observe: đăng ký hàm dọn dẹp, chạy ngược thứ tự khi disposeAll().
 */
export class Disposer {
  private readonly controller = new AbortController();
  private cleanups: Array<() => void> = [];
  private disposed = false;

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  /** Đăng ký hàm dọn dẹp. Nếu đã dispose thì chạy ngay. */
  public add(fn: () => void): void {
    if (this.disposed) {
      safeRun(fn);
      return;
    }
    this.cleanups.push(fn);
  }

  public timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = setTimeout(fn, ms);
    this.add(() => clearTimeout(id));
    return id;
  }

  public interval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
    const id = setInterval(fn, ms);
    this.add(() => clearInterval(id));
    return id;
  }

  public observe<T extends { disconnect(): void }>(observer: T): T {
    this.add(() => observer.disconnect());
    return observer;
  }

  /** Tạo Disposer con: tự dispose khi cha dispose */
  public child(): Disposer {
    const c = new Disposer();
    this.add(() => c.disposeAll());
    return c;
  }

  public disposeAll(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    const fns = this.cleanups;
    this.cleanups = [];
    for (let i = fns.length - 1; i >= 0; i--) {
      safeRun(fns[i]);
    }
  }
}

function safeRun(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (import.meta.env?.DEV) console.warn("[SubTrans] cleanup error:", err);
  }
}
