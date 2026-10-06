import { describe, expect, it, vi } from 'vitest';
import { FlowController } from '../../src/core/terminal/FlowController';

function make(high = 1000, low = 250) {
  const onPause = vi.fn();
  const onResume = vi.fn();
  const flow = new FlowController({ highWatermark: high, lowWatermark: low, onPause, onResume });
  return { flow, onPause, onResume };
}

describe('FlowController - 背压阈值', () => {
  it('未超过高水位不暂停', () => {
    const { flow, onPause } = make();
    flow.push(999);
    expect(onPause).not.toHaveBeenCalled();
    expect(flow.isPaused).toBe(false);
    expect(flow.pending).toBe(999);
  });

  it('超过高水位触发一次暂停', () => {
    const { flow, onPause } = make();
    flow.push(1001);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(flow.isPaused).toBe(true);
  });

  it('持续 push 不会重复触发暂停（防抖动）', () => {
    const { flow, onPause } = make();
    flow.push(2000);
    flow.push(2000);
    flow.push(2000);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('回落到低水位以下才恢复', () => {
    const { flow, onResume } = make();
    flow.push(2000); // 暂停
    flow.ack(1700); // pending=300，仍高于 low=250
    expect(onResume).not.toHaveBeenCalled();
    flow.ack(100); // pending=200 < 250
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(flow.isPaused).toBe(false);
  });

  it('ack 超过已推送量不会把计数打成负数', () => {
    const { flow } = make();
    flow.push(100);
    flow.ack(999);
    expect(flow.pending).toBe(0);
  });

  it('高/低水位配置非法时构造失败', () => {
    expect(() => new FlowController({ highWatermark: 100, lowWatermark: 100, onPause: () => {}, onResume: () => {} })).toThrow();
  });

  it('reset 后不再触发回调', () => {
    const { flow, onResume } = make();
    flow.push(2000);
    flow.reset();
    flow.ack(2000);
    expect(flow.pending).toBe(0);
    expect(flow.isPaused).toBe(false);
  });

  it('push(0) / ack(0) 不改变状态', () => {
    const { flow, onPause } = make();
    flow.push(0);
    flow.ack(0);
    expect(flow.pending).toBe(0);
    expect(onPause).not.toHaveBeenCalled();
  });
});