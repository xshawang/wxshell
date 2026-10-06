import { describe, expect, it } from 'vitest';
import {
  DefaultTelnetNegotiator,
  IacParser,
  OPT,
  IAC,
  DO,
  DONT,
  WILL,
  WONT,
  SB,
  SE,
  escapeIac,
} from '../../src/core/telnet/IacParser';

function makeParser(options: { cols?: number; rows?: number } = {}) {
  const sent: Buffer[] = [];
  const negotiator = new DefaultTelnetNegotiator({
    terminalType: 'xterm-256color',
    size: { cols: options.cols ?? 120, rows: options.rows ?? 30 },
  });
  const parser = new IacParser(negotiator, (data) => sent.push(data));
  return { parser, sent, negotiator, all: () => Buffer.concat(sent) };
}

describe('IacParser - 数据与协商的分离', () => {
  it('普通字节原样通过', () => {
    const { parser } = makeParser();
    expect(parser.feed(Buffer.from('hello')).toString()).toBe('hello');
  });

  it('IAC IAC 还原为单个 0xFF 且不触发协商', () => {
    const { parser, sent } = makeParser();
    const out = parser.feed(Buffer.from([0x41, IAC, IAC, 0x42]));
    expect([...out]).toEqual([0x41, 0xff, 0x42]);
    expect(sent).toHaveLength(0);
  });

  it('单字节命令（NOP/GA）被吞掉', () => {
    const { parser, sent } = makeParser();
    const out = parser.feed(Buffer.from([0x41, IAC, 241, 0x42]));
    expect([...out]).toEqual([0x41, 0x42]);
    expect(sent).toHaveLength(0);
  });
});

describe('IacParser - 选项协商', () => {
  it('远端 WILL ECHO -> 回 DO ECHO', () => {
    const { parser, sent } = makeParser();
    parser.feed(Buffer.from([IAC, WILL, OPT.ECHO]));
    expect([...sent[0]!]).toEqual([IAC, DO, OPT.ECHO]);
  });

  it('远端 WILL NAWS -> 回 DONT（NAWS 是客户端能力，服务端不该 WILL）', () => {
    const { parser, sent } = makeParser();
    parser.feed(Buffer.from([IAC, WILL, OPT.NAWS]));
    expect([...sent[0]!]).toEqual([IAC, DONT, OPT.NAWS]);
  });

  it('远端 DO NAWS -> 回 WILL NAWS 并立即推送窗口尺寸', () => {
    const { parser, sent } = makeParser({ cols: 132, rows: 43 });
    parser.feed(Buffer.from([IAC, DO, OPT.NAWS]));

    expect([...sent[0]!]).toEqual([IAC, WILL, OPT.NAWS]);

    const naws = sent[1]!;
    expect([...naws.subarray(0, 3)]).toEqual([IAC, SB, OPT.NAWS]);
    expect([...naws.subarray(naws.length - 2)]).toEqual([IAC, SE]);
    expect(naws.readUInt16BE(3)).toBe(132);
    expect(naws.readUInt16BE(5)).toBe(43);
  });

  it('远端 DO ECHO -> 回 WONT（不做本地回显）', () => {
    const { parser, sent } = makeParser();
    parser.feed(Buffer.from([IAC, DO, OPT.ECHO]));
    expect([...sent[0]!]).toEqual([IAC, WONT, OPT.ECHO]);
  });

  it('远端 WONT/DONT 不产生回复（RFC 854 防协商循环）', () => {
    const { parser, sent } = makeParser();
    parser.feed(Buffer.from([IAC, WONT, OPT.ECHO]));
    parser.feed(Buffer.from([IAC, DONT, OPT.NAWS]));
    expect(sent).toHaveLength(0);
  });
});

describe('IacParser - 子协商', () => {
  it('TERMINAL-TYPE SEND -> 回复 IS + 终端名', () => {
    const { parser, sent } = makeParser();
    parser.feed(Buffer.from([IAC, SB, OPT.TERMINAL_TYPE, 1, IAC, SE]));

    const reply = sent[0]!;
    expect([...reply.subarray(0, 3)]).toEqual([IAC, SB, OPT.TERMINAL_TYPE]);
    expect(reply[3]).toBe(0); // TTYPE_IS
    expect(reply.subarray(4, reply.length - 2).toString('ascii')).toBe('xterm-256color');
  });

  it('子协商内的 IAC IAC 被还原为一个字节', () => {
    const { parser, sent } = makeParser();
    parser.feed(Buffer.from([IAC, SB, 99, 0x41, IAC, IAC, 0x42, IAC, SE]));
    // 选项 99 无策略 -> 不回复，但解析不能崩
    expect(sent).toHaveLength(0);
  });

  it('子协商不产生终端数据', () => {
    const { parser } = makeParser();
    const out = parser.feed(Buffer.from([IAC, SB, OPT.NAWS, 0, 1, 0, 2, IAC, SE]));
    expect(out).toHaveLength(0);
  });
});

describe('IacParser - 分片不变性（最关键的性质）', () => {
  const stream = Buffer.concat([
    Buffer.from('before '),
    Buffer.from([IAC, WILL, OPT.ECHO]),
    Buffer.from('middle'),
    Buffer.from([IAC, IAC]),
    Buffer.from([IAC, SB, OPT.TERMINAL_TYPE, 1, IAC, SE]),
    Buffer.from(' after'),
  ]);

  it('一次性喂入与逐字节喂入结果完全一致', () => {
    const whole = makeParser();
    const wholeOut = whole.parser.feed(stream);

    const byteWise = makeParser();
    const parts: Buffer[] = [];
    for (const byte of stream) {
      const out = byteWise.parser.feed(Buffer.from([byte]));
      if (out.length > 0) parts.push(out);
    }
    const byteOut = Buffer.concat(parts);

    expect(byteOut.toString('latin1')).toBe(wholeOut.toString('latin1'));
    expect(whole.all().toString('latin1')).toBe(byteWise.all().toString('latin1'));
  });

  it('随机切分点下结果稳定', () => {
    const whole = makeParser();
    const wholeOut = whole.parser.feed(stream);

    for (let split = 1; split < stream.length; split += 1) {
      const p = makeParser();
      const a = p.parser.feed(stream.subarray(0, split));
      const b = p.parser.feed(stream.subarray(split));
      expect(Buffer.concat([a, b]).toString('latin1')).toBe(wholeOut.toString('latin1'));
    }
  });
});

describe('escapeIac', () => {
  it('对 0xFF 做双写', () => {
    expect([...escapeIac(Buffer.from([0x01, 0xff, 0x02]))]).toEqual([0x01, 0xff, 0xff, 0x02]);
  });
  it('无 0xFF 时原样返回', () => {
    expect([...escapeIac(Buffer.from([1, 2, 3]))]).toEqual([1, 2, 3]);
  });
});