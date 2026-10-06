/**
 * 终端背压控制器。
 *
 * 没有这一层的后果是具体的：远端 `cat` 一个大文件时，xterm.js 的写入队列会无限增长，
 * 最终把渲染进程撑爆。做法是记录"已交给消费者但尚未确认消费"的字节数，
 * 超过高水位就暂停上游（SSH 通道 / socket），回落到低水位再恢复。
 *
 * 只用一对高/低水位而不是单阈值，是为了避免在阈值附近反复 pause/resume（抖动）。
 */
export interface FlowControllerOptions {
  /** 超过该字节数则暂停上游 */
  highWatermark?: number;
  /** 回落到该字节数以下才恢复上游 */
  lowWatermark?: number;
  onPause: () => void;
  onResume: () => void;
}

export const DEFAULT_HIGH_WATERMARK = 1024 * 1024; // 1 MiB
export const DEFAULT_LOW_WATERMARK = 256 * 1024; // 256 KiB

export class FlowController {
  private readonly high: number;
  private readonly low: number;
  private readonly onPause: () => void;
  private readonly onResume: () => void;
  private unacked = 0;
  private paused = false;

  constructor(options: FlowControllerOptions) {
    this.high = options.highWatermark ?? DEFAULT_HIGH_WATERMARK;
    this.low = options.lowWatermark ?? DEFAULT_LOW_WATERMARK;
    this.onPause = options.onPause;
    this.onResume = options.onResume;

    if (this.low >= this.high) {
      throw new Error(`lowWatermark(${this.low}) 必须小于 highWatermark(${this.high})`);
    }
  }

  get pending(): number {
    return this.unacked;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 记录交给消费者的字节数 */
  push(bytes: number): void {
    if (bytes <= 0) return;
    this.unacked += bytes;
    if (!this.paused && this.unacked > this.high) {
      this.paused = true;
      this.onPause();
    }
  }

  /** 记录消费者已处理完的字节数 */
  ack(bytes: number): void {
    if (bytes <= 0) return;
    this.unacked -= bytes;
    if (this.unacked < 0) this.unacked = 0;
    if (this.paused && this.unacked < this.low) {
      this.paused = false;
      this.onResume();
    }
  }

  /** 会话关闭时复位，不应再触发回调 */
  reset(): void {
    this.unacked = 0;
    this.paused = false;
  }
}