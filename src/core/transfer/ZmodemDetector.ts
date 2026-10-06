/**
 * ZMODEM / trzsz 传输触发检测。
 *
 * 这些协议跑在**终端数据流内部**：远端执行 `rz`/`sz` 或 `trzsz` 时，
 * 会在标准输出里发出特定魔数，客户端必须嗅探到它，然后把这段字节流从
 * "送进终端渲染" 切换为 "送进传输状态机"。
 *
 * 核心难点是**半包命中**：魔数可能跨 TCP 分片到达。
 *
 * 关键设计：扣留策略不能是"永远保留 maxMagicLen-1 字节"。那样交互式场景下
 * 最后一段提示符会一直被压住不显示（例如远端只发了 "login: "，不足 15 字节就永远
 * 出不来）。正确做法是只扣留**确实是某个魔数前缀**的后缀，普通文本零延迟下发。
 */

export type TransferProtocol = 'zmodem' | 'trzsz';

export interface TransferDetection {
  protocol: TransferProtocol;
  /** 命中位置（相对于本次 feed 返回的 data 之后的偏移） */
  offset: number;
}

export interface DetectorResult {
  /** 确认与传输协议无关、可直接下发给终端的数据 */
  data: Buffer;
  detection: TransferDetection | null;
}

interface MagicPattern {
  protocol: TransferProtocol;
  magic: Buffer;
  /** 魔数之后还需要多少个字节才能定性（用于排除误命中） */
  tail: number;
  /** 对魔数后的 tail 个字节做校验；返回 false 表示这是误命中，应当作普通数据 */
  validate?: (tailBytes: Buffer) => boolean;
}

const ZPAD = 0x2a; // '*'
const ZDLE = 0x18;
const HEX = /^[0-9a-fA-F]{2}$/;

function isHexPair(buf: Buffer): boolean {
  return HEX.test(buf.toString('latin1'));
}

export const DEFAULT_PATTERNS: MagicPattern[] = [
  {
    // ZMODEM 帧头：ZPAD ZPAD ZDLE 'B' + 两个十六进制字符
    protocol: 'zmodem',
    magic: Buffer.from([ZPAD, ZPAD, ZDLE, 0x42]),
    tail: 2,
    validate: isHexPair,
  },
  {
    // trzsz 起始标记
    protocol: 'trzsz',
    magic: Buffer.from('::TRZSZ:TRANSFER:', 'ascii'),
    tail: 0,
  },
];

export class ZmodemDetector {
  private carry = Buffer.alloc(0);
  private readonly maxMagicLen: number;
  private readonly patterns: MagicPattern[];

  constructor(patterns: MagicPattern[] = DEFAULT_PATTERNS) {
    this.patterns = patterns;
    this.maxMagicLen = patterns.reduce((max, p) => Math.max(max, p.magic.length), 0);
  }

  /** 当前被扣留、尚未下发的字节数 */
  get pendingBytes(): number {
    return this.carry.length;
  }

  feed(chunk: Buffer): DetectorResult {
    const combined = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk]);
    const scan = this.scan(combined);

    if (scan.kind === 'match') {
      this.carry = Buffer.alloc(0);
      return {
        data: combined.subarray(0, scan.index),
        detection: { protocol: scan.protocol, offset: scan.index },
      };
    }

    const holdFrom = scan.kind === 'pending' ? scan.index : combined.length - this.longestPatternPrefixSuffix(combined);

    if (holdFrom <= 0) {
      this.carry = Buffer.from(combined);
      return { data: Buffer.alloc(0), detection: null };
    }

    this.carry = Buffer.from(combined.subarray(holdFrom));
    return { data: Buffer.from(combined.subarray(0, holdFrom)), detection: null };
  }

  /** 流结束时调用：把扣留的字节交还，否则输出的最后一段会丢失 */
  flush(): Buffer {
    const out = this.carry;
    this.carry = Buffer.alloc(0);
    return out;
  }

  reset(): void {
    this.carry = Buffer.alloc(0);
  }

  private scan(buf: Buffer): { kind: 'match'; index: number; protocol: TransferProtocol } | { kind: 'pending'; index: number } | { kind: 'none' } {
    let matchIndex = -1;
    let matchProtocol: TransferProtocol = 'zmodem';
    let pendingIndex = -1;

    for (const pattern of this.patterns) {
      let from = 0;
      for (;;) {
        const idx = buf.indexOf(pattern.magic, from);
        if (idx < 0) break;

        const need = idx + pattern.magic.length + pattern.tail;
        if (need > buf.length) {
          // 数据不足，无法定性 —— 必须等待后续分片
          if (pendingIndex < 0 || idx < pendingIndex) pendingIndex = idx;
          break;
        }

        const tailBytes = buf.subarray(idx + pattern.magic.length, need);
        if (!pattern.validate || pattern.validate(tailBytes)) {
          if (matchIndex < 0 || idx < matchIndex) {
            matchIndex = idx;
            matchProtocol = pattern.protocol;
          }
          break;
        }
        // 误命中：从下一个字节继续找
        from = idx + 1;
      }
    }

    // 更早的未定性位置优先：它可能才是真正的起始点
    if (pendingIndex >= 0 && (matchIndex < 0 || pendingIndex < matchIndex)) {
      return { kind: 'pending', index: pendingIndex };
    }
    if (matchIndex >= 0) return { kind: 'match', index: matchIndex, protocol: matchProtocol };
    return { kind: 'none' };
  }

  /** buf 的最长后缀中，属于某个魔数真前缀的长度 */
  private longestPatternPrefixSuffix(buf: Buffer): number {
    const maxLen = Math.min(buf.length, this.maxMagicLen - 1);
    for (let len = maxLen; len > 0; len -= 1) {
      const suffix = buf.subarray(buf.length - len);
      for (const pattern of this.patterns) {
        if (len < pattern.magic.length && pattern.magic.subarray(0, len).equals(suffix)) {
          return len;
        }
      }
    }
    return 0;
  }
}