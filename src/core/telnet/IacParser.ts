/**
 * Telnet 选项协商解析器（RFC 854 / 855 / 857 / 1073 / 1091）。
 *
 * 之所以自己实现而不用 `telnet-client` 之类的包：那些库面向"发命令-读回显"的脚本化交互，
 * 会把协商字节当普通数据处理，交互式终端下会串码。这里的职责只有两件：
 *   1) 把 IAC 协商序列从数据流里剥离，交给终端的是纯数据；
 *   2) 按策略回复协商请求。
 *
 * 状态机是必须的：IAC 序列可以跨 TCP 分片，任何"按块处理"的写法都会在边界上出错。
 */

export const IAC = 255;
export const DONT = 254;
export const DO = 253;
export const WONT = 252;
export const WILL = 251;
export const SB = 250;
export const SE = 240;
export const NOP = 241;
export const GA = 249;

export const OPT = {
  BINARY: 0,
  ECHO: 1,
  SUPPRESS_GO_AHEAD: 3,
  TERMINAL_TYPE: 24,
  NAWS: 31,
} as const;

/** TERMINAL-TYPE 子协商命令 */
export const TTYPE_IS = 0;
export const TTYPE_SEND = 1;

export interface TelnetNegotiator {
  /** 收到远端 WILL opt：返回 true 则回 DO，false 则回 DONT */
  onWill(option: number): boolean;
  /** 收到远端 DO opt：返回 true 则回 WILL，false 则回 WONT */
  onDo(option: number): boolean;
  /** 收到子协商：返回要回送的载荷（未含 IAC SB/SE 包装），null 表示不回复 */
  onSubnegotiation(option: number, payload: Buffer): Buffer | null;
  /** 同意启用选项后立即推送的初始载荷（例如 NAWS 需要马上告知窗口尺寸） */
  initialSubnegotiation?(option: number): Buffer | null;
}

export interface TelnetNegotiatorOptions {
  terminalType?: string;
  size?: { cols: number; rows: number };
}

/** RFC 要求的默认客户端行为。 */
export class DefaultTelnetNegotiator implements TelnetNegotiator {
  private terminalType: string;
  private size: { cols: number; rows: number };

  constructor(options: TelnetNegotiatorOptions = {}) {
    this.terminalType = options.terminalType ?? 'xterm-256color';
    this.size = options.size ?? { cols: 120, rows: 30 };
  }

  setSize(cols: number, rows: number): void {
    this.size = { cols, rows };
  }

  onWill(option: number): boolean {
    switch (option) {
      // 服务端回显、抑制 GO AHEAD、8 位二进制：接受
      case OPT.ECHO:
      case OPT.SUPPRESS_GO_AHEAD:
      case OPT.BINARY:
        return true;
      // NAWS / TERMINAL-TYPE 是客户端→服务端方向的能力，服务端声明 WILL 属于异常
      default:
        return false;
    }
  }

  onDo(option: number): boolean {
    switch (option) {
      case OPT.SUPPRESS_GO_AHEAD:
      case OPT.BINARY:
      case OPT.TERMINAL_TYPE:
      case OPT.NAWS:
        return true;
      // 我们不做本地回显
      case OPT.ECHO:
      default:
        return false;
    }
  }

  onSubnegotiation(option: number, payload: Buffer): Buffer | null {
    if (option === OPT.TERMINAL_TYPE && payload.length >= 1 && payload[0] === TTYPE_SEND) {
      return Buffer.concat([Buffer.from([TTYPE_IS]), Buffer.from(this.terminalType, 'ascii')]);
    }
    return null;
  }

  initialSubnegotiation(option: number): Buffer | null {
    if (option === OPT.NAWS) return this.nawsPayload();
    return null;
  }

  nawsPayload(): Buffer {
    const buf = Buffer.alloc(4);
    buf.writeUInt16BE(this.size.cols, 0);
    buf.writeUInt16BE(this.size.rows, 2);
    return buf;
  }
}

type ParserState = 'data' | 'iac' | 'negotiate' | 'subnegotiate' | 'subnegotiate-iac';

const NO_OPTION = -1;

export class IacParser {
  private state: ParserState = 'data';
  private pendingCommand = 0;
  private subOption: number = NO_OPTION;
  private subPayload: number[] = [];

  constructor(
    private readonly negotiator: TelnetNegotiator,
    /** 协商回复的出口（通常是同一个 socket） */
    private readonly send: (data: Buffer) => void,
  ) {}

  /** 输入原始字节，返回其中属于终端数据的部分（IAC IAC 已还原为单个 0xFF）。 */
  feed(chunk: Buffer): Buffer {
    const out: number[] = [];

    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) {
            this.state = 'iac';
          } else {
            out.push(byte);
          }
          break;

        case 'iac':
          if (byte === IAC) {
            // 转义的 0xFF，属于数据
            out.push(IAC);
            this.state = 'data';
          } else if (byte === DO || byte === DONT || byte === WILL || byte === WONT) {
            this.pendingCommand = byte;
            this.state = 'negotiate';
          } else if (byte === SB) {
            this.subOption = NO_OPTION;
            this.subPayload = [];
            this.state = 'subnegotiate';
          } else {
            // NOP / GA / 单字节命令 / 孤立 SE：忽略
            this.state = 'data';
          }
          break;

        case 'negotiate':
          this.state = 'data';
          this.handleNegotiation(this.pendingCommand, byte);
          break;

        case 'subnegotiate':
          if (byte === IAC) {
            this.state = 'subnegotiate-iac';
          } else if (this.subOption === NO_OPTION) {
            this.subOption = byte;
          } else {
            this.subPayload.push(byte);
          }
          break;

        case 'subnegotiate-iac':
          if (byte === SE) {
            this.state = 'data';
            this.dispatchSubnegotiation();
          } else if (byte === IAC) {
            // SB 内部的转义 0xFF
            this.subPayload.push(IAC);
            this.state = 'subnegotiate';
          } else {
            // 协议上非法；把 IAC 与当前字节都当作数据，避免状态机卡死
            this.subPayload.push(IAC, byte);
            this.state = 'subnegotiate';
          }
          break;
      }
    }

    return Buffer.from(out);
  }

  private handleNegotiation(command: number, option: number): void {
    switch (command) {
      case WILL:
        this.send(this.command(this.negotiator.onWill(option) ? DO : DONT, option));
        break;
      case DO: {
        const accepted = this.negotiator.onDo(option);
        this.send(this.command(accepted ? WILL : WONT, option));
        if (accepted) {
          // 对端同意后需要立即推送初始载荷（NAWS 窗口尺寸）
          const initial = this.negotiator.initialSubnegotiation?.(option);
          if (initial) this.sendSubnegotiation(option, initial);
        }
        break;
      }
      case WONT:
      case DONT:
        // 对端拒绝：不做确认（RFC 854 防止协商循环）
        break;
    }
  }

  private dispatchSubnegotiation(): void {
    const option = this.subOption;
    const payload = Buffer.from(this.subPayload);
    this.subOption = NO_OPTION;
    this.subPayload = [];
    if (option === NO_OPTION) return;

    const reply = this.negotiator.onSubnegotiation(option, payload);
    if (reply) this.sendSubnegotiation(option, reply);
  }

  /** 主动发送 WILL/DO 等命令 */
  sendCommand(command: number, option: number): void {
    this.send(this.command(command, option));
  }

  /** 主动发送子协商（例如窗口尺寸变化时的 NAWS） */
  sendSubnegotiation(option: number, payload: Buffer): void {
    this.send(Buffer.concat([
      Buffer.from([IAC, SB, option]),
      escapeIac(payload),
      Buffer.from([IAC, SE]),
    ]));
  }

  private command(command: number, option: number): Buffer {
    return Buffer.from([IAC, command, option]);
  }
}

/** 子协商载荷里出现的 0xFF 必须双写。 */
export function escapeIac(data: Buffer): Buffer {
  const out: number[] = [];
  for (const byte of data) {
    out.push(byte);
    if (byte === IAC) out.push(IAC);
  }
  return Buffer.from(out);
}