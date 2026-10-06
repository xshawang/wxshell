export * from './types';
export * from './errors';
export { TypedEmitter } from './emitter';

export { FlowController, DEFAULT_HIGH_WATERMARK, DEFAULT_LOW_WATERMARK } from './terminal/FlowController';
export { stripAnsi, sanitizeFileName, SessionLogWriter } from './logging/SessionLog';

export { resolveShell, shellCandidates } from './shell/resolveShell';

export { IacParser, DefaultTelnetNegotiator, escapeIac, IAC, DO, DONT, WILL, WONT, SB, SE, OPT } from './telnet/IacParser';

export { sshKeyFingerprint, sshKeyBase64, parseSshKeyBlobAlgorithm } from './ssh/sshKeyBlob';

export { readJsonFileSync, writeJsonAtomicSync, writeFileAtomicSync } from './store/JsonFile';
export {
  CONFIG_DIR_NAME,
  resolveConfigDir,
  configPaths,
  installDirOf,
  probeWritable,
  type ConfigDirInput,
  type ConfigDirResult,
  type ConfigPaths,
} from './store/configDir';
export { KnownHostsStore, parseHostToken, type HostKeyVerdict, type KnownHostEntry } from './store/KnownHostsStore';
export {
  SessionStore,
  sessionPassphraseRef,
  sessionSecretRef,
  type SessionProfile,
  type SessionProfileInput,
  type SessionFolder,
  type SshAuthConfig,
  type AuthMethod,
} from './store/SessionStore';
export { AuditLog, type AuditEvent, type AuditEventType } from './store/AuditLog';

export { Vault, deriveKek, seal, open, DEFAULT_KDF_PARAMS, type SealedBox } from './vault/Vault';

export { ZmodemDetector, DEFAULT_PATTERNS, type TransferProtocol } from './transfer/ZmodemDetector';
export { SftpClient, mapStats, type RemoteEntry, type TransferResult } from './transfer/SftpClient';

export { JumpChain, JumpChainPool, DEFAULT_JUMP_IDLE_TTL, type JumpHop, type JumpChainLease } from './tunnel/JumpChain';
export {
  LocalForwarder,
  RemoteForwarder,
  DynamicForwarder,
  type ForwardTransport,
  type RemoteForwardTransport,
} from './tunnel/PortForwarder';
export { Socks5Server, pipeBidirectional, type Socks5ServerOptions } from './tunnel/Socks5Server';

export { BaseSession } from './transport/BaseSession';
export { SshSession, type SshAuth, type HostKeyInfo, type HostKeyVerifier, type ExecResult } from './transport/SshSession';
export { TelnetSession } from './transport/TelnetSession';
export { LocalPtySession } from './transport/LocalPtySession';
export { RawTcpSession } from './transport/RawTcpSession';

export {
  SessionManager,
  type SessionManagerDeps,
  type HostKeyDecision,
  type OpenSessionRequest,
} from './session/SessionManager';
