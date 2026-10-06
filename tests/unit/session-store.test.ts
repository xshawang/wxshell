import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore, sessionPassphraseRef, sessionSecretRef } from '../../src/core/store/SessionStore';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

let root: string;

beforeEach(() => {
  root = makeTmpDir('sessions-');
});
afterEach(() => removeTmpDir(root));

const sessionsDir = (): string => join(root, 'sessions');
const sessionFiles = (): string[] =>
  existsSync(sessionsDir()) ? readdirSync(sessionsDir()).filter((f) => f.endsWith('.json')) : [];

const sshInput = {
  name: 'web-01',
  kind: 'ssh' as const,
  host: '10.0.0.11',
  ssh: { method: 'password' as const, username: 'deploy' },
};

describe('SessionStore - 私钥口令', () => {
  const keyInput = {
    name: 'key-01',
    kind: 'ssh' as const,
    host: '10.0.0.12',
    ssh: {
      method: 'publickey' as const,
      username: 'deploy',
      privateKeyPath: 'C:\\keys\\id_ed25519',
    },
  };

  it('passphraseRef 由 id 推导，且与登录口令互不覆盖', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...keyInput, passphrase: 'pp-secret' });
    expect(s.ssh?.passphraseRef).toBe(sessionPassphraseRef(s.id));
    expect(s.ssh?.secretRef).toBeUndefined();
    expect(store.getSecret(sessionPassphraseRef(s.id))).toBe('pp-secret');
  });

  it('私钥口令与连接配置写进同一个会话文件，重载后仍能取回', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...keyInput, passphrase: 'pp-secret' });

    const raw = JSON.parse(readFileSync(join(sessionsDir(), `${s.id}.json`), 'utf8'));
    expect(raw.profile.ssh.method).toBe('publickey');
    expect(raw.profile.ssh.privateKeyPath).toBe('C:\\keys\\id_ed25519');
    expect(raw.secrets[sessionPassphraseRef(s.id)]).toBe('pp-secret');

    const reloaded = new SessionStore(root);
    expect(reloaded.getSecret(sessionPassphraseRef(s.id))).toBe('pp-secret');
    expect(reloaded.getSession(s.id)?.ssh?.privateKeyPath).toBe('C:\\keys\\id_ed25519');
  });

  it('不传 passphrase 时保留文件里已存的那条', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...keyInput, passphrase: 'pp-secret' });
    store.upsertSession({ ...keyInput, id: s.id });
    expect(new SessionStore(root).getSecret(sessionPassphraseRef(s.id))).toBe('pp-secret');
  });

  it('删除会话时连私钥口令一起清掉', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...keyInput, passphrase: 'pp-secret' });
    store.deleteSession(s.id);
    expect(store.getSecret(sessionPassphraseRef(s.id))).toBeNull();
    expect(sessionFiles()).toHaveLength(0);
  });
});

describe('SessionStore - CRUD', () => {
  it('新建会话并分配默认端口', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession(sshInput);
    expect(s.id).toBeTruthy();
    expect(s.port).toBe(22);
    expect(s.createdAt).toBe(s.updatedAt);
  });

  it('telnet 默认端口 23，local 不分配端口', () => {
    const store = new SessionStore(root);
    expect(store.upsertSession({ name: 'sw', kind: 'telnet', host: '1.1.1.1' }).port).toBe(23);
    expect(store.upsertSession({ name: 'sh', kind: 'local' }).port).toBeUndefined();
  });

  it('指定端口不被覆盖', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...sshInput, port: 2222 });
    expect(s.port).toBe(2222);
  });

  it('按 id 更新而不是新建', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession(sshInput);
    const updated = store.upsertSession({ ...sshInput, id: s.id, name: 'renamed' });

    expect(store.listSessions()).toHaveLength(1);
    expect(updated.id).toBe(s.id);
    expect(updated.name).toBe('renamed');
    expect(updated.createdAt).toBe(s.createdAt);
    expect(updated.updatedAt >= s.updatedAt).toBe(true);
  });

  it('删除', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession(sshInput);
    expect(store.deleteSession(s.id)).toBe(true);
    expect(store.deleteSession(s.id)).toBe(false);
    expect(store.listSessions()).toHaveLength(0);
  });

  it('查询不存在的会话返回 null', () => {
    const store = new SessionStore(root);
    expect(store.getSession('nope')).toBeNull();
  });
});

describe('SessionStore - 一个连接一个配置文件', () => {
  it('每条连接各占一个文件，文件名就是会话 id', () => {
    const store = new SessionStore(root);
    const a = store.upsertSession({ ...sshInput, name: 'a' });
    const b = store.upsertSession({ ...sshInput, name: 'b' });

    expect(sessionFiles().sort()).toEqual([`${a.id}.json`, `${b.id}.json`].sort());
    const file = JSON.parse(
      readFileSync(join(sessionsDir(), `${a.id}.json`), 'utf8'),
    ) as { version: number; profile: { name: string } };
    expect(file.version).toBe(1);
    expect(file.profile.name).toBe('a');
  });

  it('删除会话连文件一起删掉', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession(sshInput);
    store.deleteSession(s.id);
    expect(sessionFiles()).toEqual([]);
  });

  it('单个文件损坏只跳过那一条，不影响其他连接', () => {
    const store = new SessionStore(root);
    const good = store.upsertSession({ ...sshInput, name: 'good' });
    writeFileSync(join(sessionsDir(), 'broken.json'), '{ 这不是 JSON');

    const reloaded = new SessionStore(root);
    expect(reloaded.listSessions()).toHaveLength(1);
    expect(reloaded.listSessions()[0]!.id).toBe(good.id);
  });

  it('空文件不当作会话', () => {
    const store = new SessionStore(root);
    store.upsertSession(sshInput);
    writeFileSync(join(sessionsDir(), 'empty.json'), '');

    expect(new SessionStore(root).listSessions()).toHaveLength(1);
  });

  it('原子写入不残留临时文件', () => {
    const store = new SessionStore(root);
    store.upsertSession(sshInput);
    const leftovers = readdirSync(sessionsDir()).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('SessionStore - 口令随会话文件保存', () => {
  it('保存的口令与配置在同一个文件里，重新加载后仍能读回', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...sshInput, password: 's3cret' });
    const ref = sessionSecretRef(s.id);

    expect(s.ssh?.secretRef).toBe(ref);
    const raw = readFileSync(join(sessionsDir(), `${s.id}.json`), 'utf8');
    expect(JSON.parse(raw).secrets[ref]).toBe('s3cret');

    // 配置里不带明文，明文只在 secrets 段
    expect(JSON.parse(raw).profile.ssh.password).toBeUndefined();

    const reloaded = new SessionStore(root);
    expect(reloaded.getSecret(ref)).toBe('s3cret');
  });

  it('secretRef 由 id 推导，跨重建稳定', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...sshInput, password: 'p' });
    const again = new SessionStore(root).getSession(s.id);
    expect(again!.ssh!.secretRef).toBe(sessionSecretRef(s.id));
  });

  it('不传 password 表示保留已有口令', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...sshInput, password: 'keep-me' });
    store.upsertSession({ ...sshInput, id: s.id, name: 'renamed' });

    expect(new SessionStore(root).getSecret(sessionSecretRef(s.id))).toBe('keep-me');
  });

  it('传空串表示清掉口令', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...sshInput, password: 'gone' });
    store.upsertSession({ ...sshInput, id: s.id, password: '' });

    expect(store.getSecret(sessionSecretRef(s.id))).toBe('');
    expect(new SessionStore(root).getSecret(sessionSecretRef(s.id))).toBe('');
  });

  it('删除会话时口令一起消失', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({ ...sshInput, password: 'p' });
    const ref = sessionSecretRef(s.id);
    store.deleteSession(s.id);
    expect(store.getSecret(ref)).toBeNull();
  });

  it('公钥认证不写入 secretRef', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession({
      name: 'key',
      kind: 'ssh',
      host: 'h',
      ssh: { method: 'publickey', username: 'u', privateKeyPath: 'C:\\k' },
    });
    expect(s.ssh?.secretRef).toBeUndefined();
  });
});

describe('SessionStore - 校验', () => {
  it('名称为空被拒绝', () => {
    const store = new SessionStore(root);
    expect(() => store.upsertSession({ name: '  ', kind: 'local' })).toThrow(/名称/);
  });

  it('ssh 会话缺少 host / 用户名被拒绝', () => {
    const store = new SessionStore(root);
    expect(() => store.upsertSession({ name: 'a', kind: 'ssh', ssh: { method: 'password', username: 'u' } })).toThrow(/host/);
    expect(() => store.upsertSession({ name: 'a', kind: 'ssh', host: 'h' })).toThrow(/用户名/);
  });

  it('公钥认证缺私钥路径被拒绝', () => {
    const store = new SessionStore(root);
    expect(() =>
      store.upsertSession({ name: 'a', kind: 'ssh', host: 'h', ssh: { method: 'publickey', username: 'u' } }),
    ).toThrow(/私钥/);
  });

  it('telnet / rawtcp 缺 host 被拒绝', () => {
    const store = new SessionStore(root);
    expect(() => store.upsertSession({ name: 'a', kind: 'telnet' })).toThrow(/host/);
    expect(() => store.upsertSession({ name: 'a', kind: 'rawtcp' })).toThrow(/host/);
  });

  it('会话不能把自己作为跳板', () => {
    const store = new SessionStore(root);
    const s = store.upsertSession(sshInput);
    expect(() => store.upsertSession({ ...sshInput, id: s.id, jumpChain: [s.id] })).toThrow(/跳板/);
  });

  it('父目录不存在被拒绝', () => {
    const store = new SessionStore(root);
    expect(() => store.upsertSession({ ...sshInput, parentId: 'ghost' })).toThrow(/目录/);
  });
});

describe('SessionStore - 目录树', () => {
  it('创建目录并把会话挂进去', () => {
    const store = new SessionStore(root);
    const folder = store.createFolder('生产');
    const s = store.upsertSession({ ...sshInput, parentId: folder.id });

    const tree = store.tree();
    expect(tree.folders).toHaveLength(1);
    expect(tree.sessions[0]!.parentId).toBe(folder.id);
    expect(s.parentId).toBe(folder.id);
  });

  it('目录不存在时创建子目录被拒绝', () => {
    const store = new SessionStore(root);
    expect(() => store.createFolder('x', 'ghost')).toThrow(/父目录/);
  });

  it('删除目录时子项上移而不是变成孤儿', () => {
    const store = new SessionStore(root);
    const parent = store.createFolder('根');
    const child = store.createFolder('子', parent.id);
    const s = store.upsertSession({ ...sshInput, parentId: child.id });

    store.deleteFolder(child.id);

    expect(store.getFolder(child.id)).toBeNull();
    expect(store.getSession(s.id)!.parentId).toBe(parent.id);
  });

  it('删除目录后子会话的新 parentId 落盘', () => {
    const store = new SessionStore(root);
    const parent = store.createFolder('根');
    const child = store.createFolder('子', parent.id);
    const s = store.upsertSession({ ...sshInput, parentId: child.id });
    store.deleteFolder(child.id);

    expect(new SessionStore(root).getSession(s.id)!.parentId).toBe(parent.id);
  });

  it('指向不存在目录的会话在 tree 中归到根', () => {
    // 直接写入脏配置模拟历史遗留数据
    const store = new SessionStore(root);
    const s = store.upsertSession(sshInput);
    const dirty = JSON.parse(readFileSync(join(sessionsDir(), `${s.id}.json`), 'utf8'));
    dirty.profile.parentId = 'ghost';
    writeFileSync(join(sessionsDir(), `${s.id}.json`), JSON.stringify(dirty));

    const reloaded = new SessionStore(root);
    expect(reloaded.tree().sessions[0]!.parentId).toBeNull();
    // 原始数据本身不能被销毁
    expect(reloaded.listSessions()[0]!.parentId).toBe('ghost');
  });

  it('移动会话', () => {
    const store = new SessionStore(root);
    const folder = store.createFolder('f');
    const s = store.upsertSession(sshInput);
    expect(store.moveSession(s.id, folder.id)).toBe(true);
    expect(store.getSession(s.id)!.parentId).toBe(folder.id);
    expect(store.moveSession('ghost', folder.id)).toBe(false);
  });

  it('移动会话后不丢口令', () => {
    const store = new SessionStore(root);
    const folder = store.createFolder('f');
    const s = store.upsertSession({ ...sshInput, password: 'p' });
    store.moveSession(s.id, folder.id);

    const reloaded = new SessionStore(root);
    expect(reloaded.getSession(s.id)!.parentId).toBe(folder.id);
    expect(reloaded.getSecret(sessionSecretRef(s.id))).toBe('p');
  });

  it('检测目录环', () => {
    const store = new SessionStore(root);
    const a = store.createFolder('a');
    const b = store.createFolder('b', a.id);
    expect(store.findFolderCycle()).toBeNull();

    // 直接构造环：a.parent = b
    const file = JSON.parse(JSON.stringify({ version: 1, folders: store.listFolders() }));
    file.folders.find((f: { id: string }) => f.id === a.id).parentId = b.id;
    writeFileSync(join(root, 'folders.json'), JSON.stringify(file));

    const cyc = new SessionStore(root);
    expect(cyc.findFolderCycle()).not.toBeNull();
  });
});

describe('SessionStore - 持久化', () => {
  it('重新加载后数据完整', () => {
    const store = new SessionStore(root);
    const folder = store.createFolder('f');
    store.upsertSession({ ...sshInput, parentId: folder.id });

    const reloaded = new SessionStore(root);
    expect(reloaded.listFolders()).toHaveLength(1);
    expect(reloaded.listSessions()[0]!.name).toBe('web-01');
  });

  it('目录写在 folders.json，会话写在 sessions/ 下', () => {
    const store = new SessionStore(root);
    store.createFolder('f');
    store.upsertSession(sshInput);

    expect(existsSync(join(root, 'folders.json'))).toBe(true);
    expect(sessionFiles()).toHaveLength(1);
  });

  it('配置目录不存在时以空库启动', () => {
    const store = new SessionStore(join(root, 'missing'));
    expect(store.listSessions()).toEqual([]);
    expect(store.listFolders()).toEqual([]);
  });
});
