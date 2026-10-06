/** 项目统一错误基类；code 用于 UI 分类展示与审计记录。 */
export class XshellError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotSupportedError extends XshellError {
  constructor(message: string) {
    super(message, 'ENOTSUPPORTED');
  }
}

export class AuthError extends XshellError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'EAUTH', options);
  }
}

/** 主机密钥与已知记录不一致 —— 默认必须阻断连接。 */
export class HostKeyMismatchError extends XshellError {
  constructor(
    message: string,
    readonly details: { host: string; port: number; keyType: string; expected: string; actual: string },
  ) {
    super(message, 'EHOSTKEY_MISMATCH');
  }
}

export class VaultLockedError extends XshellError {
  constructor(message = '保险库未解锁') {
    super(message, 'EVAULT_LOCKED');
  }
}

export class InvalidPasswordError extends XshellError {
  constructor(message = '主密码错误') {
    super(message, 'EVAULT_BAD_PASSWORD');
  }
}

export class ConfigError extends XshellError {
  constructor(message: string) {
    super(message, 'ECONFIG');
  }
}