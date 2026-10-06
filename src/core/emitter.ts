import { EventEmitter } from 'node:events';

type CallbackOf<T> = T extends (...args: infer A) => void ? (...args: A) => void : never;

/**
 * 类型安全的事件发射器。
 * 约束写成 `extends object` 而不是 `Record<string, Function>`：interface 声明的事件表
 * 没有隐式索引签名，用 Record 约束会让所有 interface 用法直接编译失败。
 *
 * Node 的 EventEmitter 默认 10 个监听上限，多窗口共享同一会话时会误报泄漏，这里放宽。
 */
export class TypedEmitter<E extends object> {
  private readonly emitter = new EventEmitter();

  constructor(maxListeners = 100) {
    this.emitter.setMaxListeners(maxListeners);
  }

  on<K extends keyof E & string>(ev: K, cb: E[K]): this {
    this.emitter.on(ev, cb as unknown as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof E & string>(ev: K, cb: E[K]): this {
    this.emitter.off(ev, cb as unknown as (...args: unknown[]) => void);
    return this;
  }

  protected emit<K extends keyof E & string>(ev: K, ...args: Parameters<CallbackOf<E[K]>>): boolean {
    return this.emitter.emit(ev, ...args);
  }

  removeAllListeners(ev?: string): void {
    this.emitter.removeAllListeners(ev);
  }

  listenerCount(ev: string): number {
    return this.emitter.listenerCount(ev);
  }
}