import { randomUUID } from 'node:crypto';
import { TypedEmitter } from '../emitter';
import type { CloseInfo, Session, SessionCapabilities, SessionEvents, SessionKind, SessionState } from '../types';

/** 会话共通部分：状态机 + 事件 + 关闭去重。 */
export abstract class BaseSession extends TypedEmitter<SessionEvents> implements Session {
  abstract readonly capabilities: SessionCapabilities;

  protected currentState: SessionState = 'idle';
  private closeEmitted = false;

  constructor(
    readonly id: string = randomUUID(),
    readonly kind: SessionKind,
  ) {
    super();
    // 兜底监听：Node 的 EventEmitter 在 'error' 没有监听者时会直接 throw，
    // 而这个 emit 常常发生在第三方库（ssh2）的回调里，抛出会变成未捕获异常
    // 并让等待中的 promise 永不 settle。真实消费者（SessionManager）会另外挂监听。
    this.on('error', () => undefined);
  }

  get state(): SessionState {
    return this.currentState;
  }

  /**
   * 是否已经关闭过。
   *
   * close() 必须幂等：底层资源销毁后不会再产生新的事件，重复 close 会等一个
   * 永远不来的回调（TCP 类会永久挂起，PTY/SSH 类会白等 3 秒兜底超时）。
   */
  protected get isClosed(): boolean {
    return this.closeEmitted;
  }

  protected setState(state: SessionState, detail?: string): void {
    // 'closed' 是终态：重复 close() 不应该把状态倒回 'closing'
    if (this.closeEmitted) return;
    this.currentState = state;
    this.emit('state', state, detail);
  }

  /** 关闭事件只发一次：上层依赖它做资源回收，重复触发会导致重复记账 */
  protected emitClose(info: CloseInfo): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.currentState = 'closed';
    this.emit('close', info);
  }

  protected fail(err: Error): void {
    this.currentState = 'error';
    this.emit('error', err);
  }

  abstract connect(): Promise<void>;
  abstract write(data: Buffer | string): void;
  abstract resize(cols: number, rows: number): void;
  abstract pause(): void;
  abstract resume(): void;
  abstract close(reason?: string): Promise<void>;
}
