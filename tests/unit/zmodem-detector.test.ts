import { describe, expect, it } from 'vitest';
import { ZmodemDetector } from '../../src/core/transfer/ZmodemDetector';

const ZM = Buffer.from([0x2a, 0x2a, 0x18, 0x42, 0x30, 0x30]); // '**\x18B00'
const TZ = Buffer.from('::TRZSZ:TRANSFER:', 'ascii');

describe('ZmodemDetector - 基本嗅探', () => {
  it('普通文本零扣留：不含任何魔数前缀时必须整段下发', () => {
    const d = new ZmodemDetector();
    const text = 'hello world, this is plain terminal output';
    const out = d.feed(Buffer.from(text));
    expect(out.detection).toBeNull();
    // 交互式场景的关键性质：远端只发一个提示符也必须立刻显示，不能被扣住
    expect(out.data.toString()).toBe(text);
    expect(d.pendingBytes).toBe(0);
  });

  it('只扣留确实是魔数前缀的尾部', () => {
    const d = new ZmodemDetector();
    const out = d.feed(Buffer.from('prompt$ **'));
    expect(out.data.toString()).toBe('prompt$ ');
    expect(d.pendingBytes).toBe(2);
  });

  it('flush 交还扣留字节，避免输出末尾丢失', () => {
    const d = new ZmodemDetector();
    d.feed(Buffer.from('tail **'));
    expect(d.flush().toString()).toBe('**');
    expect(d.pendingBytes).toBe(0);
  });

  it('命中 ZMODEM 魔数并切分数据', () => {
    const d = new ZmodemDetector();
    const prefix = Buffer.from('ls\r\nsome output\r\n');
    const out = d.feed(Buffer.concat([prefix, ZM, Buffer.from('rest')]));
    expect(out.detection).not.toBeNull();
    expect(out.detection!.protocol).toBe('zmodem');
    expect(out.detection!.offset).toBe(prefix.length);
    expect(out.data.toString()).toBe('ls\r\nsome output\r\n');
  });

  it('命中 trzsz 标记', () => {
    const d = new ZmodemDetector();
    const out = d.feed(Buffer.concat([Buffer.from('abc'), TZ, Buffer.from('1:1:...')]));
    expect(out.detection?.protocol).toBe('trzsz');
    expect(out.data.toString()).toBe('abc');
  });

  it('魔数紧跟的两个字节必须是十六进制，否则视为误命中', () => {
    const d = new ZmodemDetector();
    const bad = Buffer.from([0x2a, 0x2a, 0x18, 0x42, 0x7a, 0x7a]); // 'zz' 不是 hex
    const out = d.feed(Buffer.concat([Buffer.from('x'), bad]));
    expect(out.detection).toBeNull();
    expect(out.data.toString('latin1')).toBe('x**\u0018Bzz');
  });
});

describe('ZmodemDetector - 半包命中（跨分片）', () => {
  it('魔数被切成两半仍能命中', () => {
    const d = new ZmodemDetector();
    const payload = Buffer.concat([Buffer.from('pre '), ZM, Buffer.from('tail')]);

    const first = d.feed(payload.subarray(0, 6)); // 'pre ' + '**'
    expect(first.detection).toBeNull();
    // 只有 '**' 这半截魔数被扣住，前面的普通文本必须立即下发
    expect(first.data.toString()).toBe('pre ');
    expect(d.pendingBytes).toBe(2);

    const second = d.feed(payload.subarray(6));
    expect(second.detection?.protocol).toBe('zmodem');
    // 检测到之后的数据由上层切换处理，检测器不再下发
    expect(second.data).toHaveLength(0);
  });

  it('逐字节喂入与一次性喂入得到相同的检测结果', () => {
    const payload = Buffer.concat([Buffer.from('output line\r\n'), ZM, Buffer.from('rest')]);

    const whole = new ZmodemDetector();
    const wholeResult = whole.feed(payload);

    const byteWise = new ZmodemDetector();
    const parts: Buffer[] = [];
    let detected: string | null = null;
    for (const byte of payload) {
      const r = byteWise.feed(Buffer.from([byte]));
      if (r.data.length > 0) parts.push(r.data);
      if (r.detection) {
        detected = r.detection.protocol;
        break; // 检测到之后由上层接管，不再喂入检测器
      }
    }

    expect(detected).toBe('zmodem');
    // 不变量：检测发生前下发的数据必须与一次性喂入完全一致
    expect(Buffer.concat(parts).toString()).toBe(wholeResult.data.toString());
  });
});

describe('ZmodemDetector - 状态复位', () => {
  it('reset 清空缓冲', () => {
    const d = new ZmodemDetector();
    d.feed(Buffer.from('abcdefgh'));
    expect(d.pendingBytes).toBe(0); // 普通文本零扣留

    d.feed(Buffer.from('**')); // 魔数前缀，必须被扣住
    expect(d.pendingBytes).toBe(2);

    d.reset();
    expect(d.pendingBytes).toBe(0);
  });

  it('无数据时不产生空命中', () => {
    const d = new ZmodemDetector();
    const out = d.feed(Buffer.alloc(0));
    expect(out.detection).toBeNull();
    expect(out.data).toHaveLength(0);
  });
});